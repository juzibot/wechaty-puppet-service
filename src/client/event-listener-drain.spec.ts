import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { PuppetService } from './puppet-service.js'
import { GrpcManager } from './grpc-manager.js'

class ListenerService extends PuppetService {

  protected override hookPayloadStore (): void {}
  attach (manager: GrpcManager): void { this._grpcManager = manager; this.bridgeGrpcEventStream(manager) }
  async cleanup (): Promise<void> { await this.onStop(); await this._payloadStore.destroy() }

}

test('tracked emission retains once, removal, order, this binding and boolean results', async t => {
  const service = new ListenerService({ token: `insecure_${randomUUID()}` })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  service.attach(manager)
  let release!: () => void
  const blocked = new Promise<void>((resolve): void => { release = resolve })
  const order: string[] = []
  const removed = (): void => { order.push('removed') }
  const once = async function (this: ListenerService): Promise<void> {
    assert.equal(this, service); order.push('once'); await blocked
  }
  try {
    assert.equal(service.emit('dong', { data: 'empty' }), false)
    service.on('dong', removed); service.removeListener('dong', removed)
    service.once('dong', once)
    service.prependOnceListener('dong', (): void => { order.push('first') })
    assert.equal(service.emit('dong', { data: 'one' }), true)
    assert.equal(service.emit('dong', { data: 'two' }), false)
    assert.deepEqual(order, [ 'first', 'once' ])
    assert.equal(service.listenerCount('dong'), 0)
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 20 }), /deadline/)
    release(); await service.prepareForRestart({ deadline: Date.now() + 1000 })
    t.pass('raw once wrappers retain EventEmitter behavior while their promises drain')
  } finally { release(); await service.cleanup(); sinon.restore() }
})

test('sync throws and async rejections remain sticky without unhandled rejection', async t => {
  for (const asyncFailure of [ false, true ]) {
    const service = new ListenerService({ token: `insecure_${randomUUID()}` })
    const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
    sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
    service.attach(manager)
    const unhandled: unknown[] = []
    const observe = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', observe)
    try {
      if (asyncFailure) {
        service.on('message', async (): Promise<void> => { throw new Error('async bridge failed') })
        assert.equal(service.emit('message', { messageId: 'id' }), true)
      } else {
        service.on('message', (): never => { throw new Error('sync bridge failed') })
        assert.throws((): void => { service.emit('message', { messageId: 'id' }) }, /sync bridge failed/)
      }
      await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 1000 }), /bridge failed/)
      await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 1000 }), /bridge failed/)
      await new Promise<void>((resolve): void => { setImmediate(resolve) })
      assert.deepEqual(unhandled, [])
    } finally { process.off('unhandledRejection', observe); await service.cleanup(); sinon.restore() }
  }
  t.pass('listeners fail visibly at the restart barrier without process-level rejection leaks')
})

test('old listener failures cannot poison the next start or its preparation task', async t => {
  const service = new ListenerService({ token: `insecure_${randomUUID()}` })
  sinon.stub(GrpcManager.prototype, 'start').resolves(); sinon.stub(GrpcManager.prototype, 'stop').resolves(); sinon.stub(GrpcManager.prototype, 'stopStream')
  let rejectOld!: (error: Error) => void
  const old = new Promise<void>((_resolve, reject): void => { rejectOld = reject })
  service.once('message', async (): Promise<void> => old)
  try {
    await service.onStart()
    service.emit('message', { messageId: 'old' })
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 20 }), /deadline/)
    await service.onStop(); await service.onStart()
    rejectOld(new Error('old session failure'))
    await service.prepareForRestart({ deadline: Date.now() + 1000 })
    t.pass('listener drain state is owned by the start that emitted the event')
  } finally { rejectOld(new Error('cleanup')); await service.cleanup(); sinon.restore() }
})

test('normal event processing can deliver READY while an async listener waits for a business write', async t => {
  const server = new grpc.Server()
  let writes = 0
  server.addService(puppet.PuppetService, {
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      for (const [ type, payload, seq ] of [
        [ puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }, 0 ],
        [ puppet.EventType.EVENT_TYPE_MESSAGE, { messageId: 'incoming' }, 1 ],
        [ puppet.EventType.EVENT_TYPE_READY, {}, 0 ],
        [ puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'account', throughSeq: 1 }, 0 ],
      ] as const) {
        const event = new puppet.EventResponse()
        event.setType(type); event.setPayload(JSON.stringify(payload)); event.setSeq(seq); call.write(event)
      }
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { callback(null, new puppet.StartResponse()) },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
    messageSendText: (_call: grpc.ServerUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>, callback: grpc.sendUnaryData<puppet.MessageSendTextResponse>): void => { writes++; callback(null, new puppet.MessageSendTextResponse()) },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const service = new ListenerService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: true } })
  let completed!: () => void
  const completion = new Promise<void>((resolve): void => { completed = resolve })
  service.on('message', async (): Promise<void> => {
    await service.withRecoveryRequestContext({ deadline: Date.now() + 1000 }, async (): Promise<string | void> => service.messageSendText('contact', 'reply'))
    completed()
  })
  let timer: NodeJS.Timeout | undefined
  try {
    await service.onStart()
    await Promise.race([ completion, new Promise<never>((_resolve, reject): void => { timer = setTimeout((): void => { reject(new Error('listener blocked READY processing')) }, 1500) }) ])
    await service.prepareForRestart({ deadline: Date.now() + 1000 })
    assert.equal(writes, 1)
    t.pass('listener promises are joined only by preparation, never by the event worker')
  } finally { clearTimeout(timer); await service.cleanup(); server.forceShutdown() }
})
