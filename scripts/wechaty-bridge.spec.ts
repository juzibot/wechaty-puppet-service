import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import * as PUPPET from '@juzi/wechaty-puppet'
import { puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { PuppetService } from '../src/client/puppet-service.js'
import { GrpcManager } from '../src/client/grpc-manager.js'

interface BridgeBot {
  init(): Promise<void>
  on(event: string, listener: (...args: unknown[]) => unknown): BridgeBot
  removeAllListeners(): BridgeBot
}
interface BridgeModule {
  WechatyBuilder: { build(options: { puppet: PuppetService }): BridgeBot }
}

class BridgeService extends PuppetService {

  protected override hookPayloadStore (): void {}
  attach (manager: GrpcManager): void { this._grpcManager = manager; this.bridgeGrpcEventStream(manager) }
  async cleanup (): Promise<void> { await this.onStop(); await this._payloadStore.destroy() }

}

test('published Wechaty 1.2 message bridge finishes before prepare resolves', async t => {
  // Explicit integration target: install the published Wechaty package only in the validation overlay.
  const moduleName = process.env['WECHATY_BRIDGE_MODULE'] ?? '@juzi/wechaty'
  const { WechatyBuilder } = await import(moduleName) as BridgeModule
  const service = new BridgeService({ token: `insecure_${randomUUID()}` })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  service.attach(manager)
  service.login('self')
  const bot = WechatyBuilder.build({ puppet: service })
  let release!: () => void
  const blocked = new Promise<void>((resolve): void => { release = resolve })
  let entered!: () => void
  const entry = new Promise<void>((resolve): void => { entered = resolve })
  sinon.stub(service, 'messagePayload').callsFake(async (id): Promise<PUPPET.payloads.Message> => {
    entered(); await blocked
    return { id, type: PUPPET.types.Message.Text, text: 'bridge', timestamp: Date.now(), talkerId: 'contact', listenerId: 'self' }
  })
  sinon.stub(service, 'contactPayload').callsFake(async (id): Promise<PUPPET.payloads.Contact> => ({ id, name: id, avatar: '', phone: [], gender: PUPPET.types.ContactGender.Unknown, type: PUPPET.types.Contact.Individual, friend: true }))
  let pendingBotTasks = 0
  let releaseBusiness!: () => void
  const business = new Promise<void>((resolve): void => { releaseBusiness = resolve })
  const errors: unknown[] = []
  bot.on('message', async (): Promise<void> => { pendingBotTasks++; await business; pendingBotTasks-- })
  bot.on('error', (error): void => { errors.push(error) })
  try {
    await bot.init()
    const event = new puppet.EventResponse()
    event.setType(puppet.EventType.EVENT_TYPE_MESSAGE); event.setPayload(JSON.stringify({ messageId: 'message' })); event.setSeq(1)
    manager.emit('data', event)
    await entry
    assert.equal(pendingBotTasks, 0)
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 20 }), /deadline/)
    release()
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.equal(pendingBotTasks, 1)
    assert.deepEqual(errors, [])
    manager.emit('data', event)
    assert.equal(pendingBotTasks, 1)
    t.pass('real Message.find/payload loading can no longer outlive the SDK barrier')
  } finally { release(); releaseBusiness(); bot.removeAllListeners(); await service.cleanup(); sinon.restore() }
})
