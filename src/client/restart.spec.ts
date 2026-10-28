import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { PuppetService } from './puppet-service.js'
import { GrpcManager } from './grpc-manager.js'

class RestartService extends PuppetService {
  protected override hookPayloadStore (): void {}
  attach (manager: GrpcManager): void { this._grpcManager = manager; this.bridgeGrpcEventStream(manager) }
  get metadata () { return this._payloadStore.miscellaneous! }
  async cleanup (): Promise<void> { await this.onStop(); await this._payloadStore.destroy() }
}

function event (seq: number): puppet.EventResponse {
  const response = new puppet.EventResponse()
  response.setType(puppet.EventType.EVENT_TYPE_DONG)
  response.setPayload(JSON.stringify({ data: String(seq) }))
  response.setSeq(seq)
  return response
}

test('prepare drains accepted events and metadata, rejects new events and suppresses reconnect', async t => {
  const service = new RestartService({ token: randomUUID() })
  const manager = new GrpcManager({ token: randomUUID() })
  const stop = sinon.stub(manager, 'stopStream').callsFake((): void => { manager.emit('cancel'); manager.emit('error', new Error('cancelled')) })
  const close = sinon.stub(manager, 'stop').resolves()
  const received: string[] = []
  service.on('dong', ({ data }): void => { received.push(data!) })
  service.on('error', (): never => { throw new Error('Unexpected stream error') })
  service.attach(manager)
  try {
    manager.emit('data', event(1)); manager.emit('data', event(2))
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    manager.emit('data', event(3))
    await service.reset()
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.deepEqual(received, [ '1', '2' ])
    assert.equal(await service.metadata.get('lastEventSeq'), '2')
    assert.equal(stop.callCount, 1)
    assert.equal(close.callCount, 0)
    assert.equal(service.grpcManager, manager)
    t.pass('queued workers and client survive the intake fence')
  } finally { await service.cleanup(); sinon.restore() }
})

test('prepare propagates checkpoint failure permanently', async t => {
  const service = new RestartService({ token: randomUUID() })
  const manager = new GrpcManager({ token: randomUUID() })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  sinon.stub(service.metadata, 'set').rejects(new Error('checkpoint write failed'))
  service.attach(manager)
  try {
    manager.emit('data', event(1))
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /checkpoint write failed/)
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /checkpoint write failed/)
    t.pass('checkpoint failures cannot become successful preparation')
  } finally { sinon.restore(); sinon.stub(manager, 'stop').resolves(); await service.cleanup(); sinon.restore() }
})
