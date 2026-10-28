import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { GrpcManager } from './grpc-manager.js'
import { PuppetService } from './puppet-service.js'

class LifecycleService extends PuppetService {

  attach (manager: GrpcManager): void { this._grpcManager = manager; this.bridgeGrpcEventStream(manager) }
  get store () { return this._payloadStore }
  async cleanup (): Promise<void> { await this.onStop(); await this._payloadStore.destroy() }

}

function response (type: ReturnType<puppet.EventResponse['getType']>, payload: unknown, seq = 1): puppet.EventResponse {
  const event = new puppet.EventResponse()
  event.setType(type); event.setPayload(JSON.stringify(payload)); event.setSeq(seq)
  return event
}

test('real login bridge synchronous listener failure makes preparation fail', async t => {
  const service = new LifecycleService({ token: `insecure_${randomUUID()}` })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  sinon.stub(service.store, 'start').resolves()
  service.attach(manager)
  service.on('login', (): never => { throw new Error('login listener failed') })
  try {
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }))
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 1000 }), /login listener failed/)
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 1000 }), /login listener failed/)
    t.pass('SDK login failure cannot be mistaken for a drained event queue')
  } finally { await service.cleanup(); sinon.restore() }
})

test('prepare waits for the SDK login-store listener and retains its delayed failure', async t => {
  const service = new LifecycleService({ token: `insecure_${randomUUID()}` })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  let entered!: () => void
  const entry = new Promise<void>((resolve): void => { entered = resolve })
  let rejectStore!: (error: Error) => void
  const operation = new Promise<void>((_resolve, reject): void => { rejectStore = reject })
  sinon.stub(service.store, 'start').callsFake(async (): Promise<void> => { entered(); await operation })
  service.attach(manager)
  try {
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }))
    await entry
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 20 }), /deadline/)
    rejectStore(new Error('delayed login store failure'))
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 1000 }), /delayed login store failure/)
    t.pass('SDK listener completion is separate from application async listeners')
  } finally { rejectStore(new Error('cleanup')); await service.cleanup(); sinon.restore() }
})

test('stop owns the old manager across blocked checkpoints and concurrent start', async t => {
  const service = new LifecycleService({ token: `insecure_${randomUUID()}` })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  const start = sinon.stub(GrpcManager.prototype, 'start').resolves()
  const stop = sinon.stub(GrpcManager.prototype, 'stop').resolves()
  sinon.stub(GrpcManager.prototype, 'stopStream')
  let entered!: () => void
  const entry = new Promise<void>((resolve): void => { entered = resolve })
  let release!: () => void
  const blocked = new Promise<void>((resolve): void => { release = resolve })
  const original = service.store.miscellaneous!.set.bind(service.store.miscellaneous!)
  sinon.stub(service.store.miscellaneous!, 'set').callsFake(async (key, value): ReturnType<typeof original> => { entered(); await blocked; return original(key, value) })
  service.attach(manager)
  try {
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_DONG, { data: 'queued' }))
    await entry
    const stopping = service.onStop()
    const starting = service.onStart()
    release()
    await Promise.all([ stopping, starting ])
    assert.equal(stop.callCount, 1)
    assert.equal(stop.firstCall.thisValue, manager)
    assert.notEqual(service.grpcManager, manager)
    assert.equal(start.lastCall.thisValue, service.grpcManager)
    await service.prepareForRestart({ deadline: Date.now() + 1000 })
    t.pass('old connection is closed and the new manager remains owned and usable')
  } finally { release(); await service.cleanup(); sinon.restore() }
})
