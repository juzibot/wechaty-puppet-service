import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { grpc, puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { GrpcManager } from './grpc-manager.js'
import { PuppetService } from './puppet-service.js'

interface ResumePositionReader {
  eventResumePosition: () => Promise<{ lastEventSeq?: string, accountId?: string }>
}

async function bounded<Result> (operation: Promise<Result>): Promise<Result> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([ operation, new Promise<never>((_resolve, reject): void => {
      timer = setTimeout((): void => { reject(new Error('test operation did not settle')) }, 5000)
    }) ])
  } finally { clearTimeout(timer) }
}

class TransportService extends PuppetService {

  get manager (): GrpcManager | undefined { return this._grpcManager }
  async cleanup (): Promise<void> { await this.onStop(); await this._payloadStore.destroy() }

}

test('prearmed deadlines are validated and stop invalidates a not-yet-started generation', async t => {
  const service = new TransportService({ token: `insecure_${randomUUID()}` })
  const start = sinon.stub(GrpcManager.prototype, 'start').resolves()
  sinon.stub(GrpcManager.prototype, 'stop').resolves()
  sinon.stub(GrpcManager.prototype, 'stopStream')
  try {
    await assert.rejects(service.waitForTransportStart({ deadline: Number.NaN }), RangeError)
    const first = assert.rejects(service.waitForTransportStart({ deadline: Date.now() + 20 }), /deadline/)
    const second = assert.rejects(service.waitForTransportStart({ deadline: Date.now() + 1000 }), /deadline/)
    await Promise.all([ first, second ])
    await assert.rejects(service.onStart(), /deadline/)
    assert.equal(start.callCount, 0)
    const stopped = assert.rejects(service.waitForTransportStart({ deadline: Date.now() + 1000 }), /stop/)
    await service.onStop(); await stopped
    await Promise.all([ service.waitForTransportStart({ deadline: Date.now() + 1000 }), service.onStart() ])
    await service.waitForTransportStart({ deadline: Date.now() + 1000 })
    assert.equal(start.callCount, 1)
    t.pass('all waiters share one generation, including before start and after success')
  } finally { await service.cleanup(); sinon.restore() }
})

for (const mode of [ 'scan', 'rpc-error', 'rpc-timeout', 'refused', 'recovery' ] as const) {
  test(`real gRPC transport start: ${mode}`, async t => {
    const server = new grpc.Server()
    let stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse> | undefined
    let calls = 0
    let recovered!: () => void
    const recovery = new Promise<void>((resolve): void => { recovered = resolve })
    server.addService(puppet.PuppetService, {
      event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
        stream = call
        const event = new puppet.EventResponse()
        event.setType(puppet.EventType.EVENT_TYPE_SCAN)
        event.setPayload(JSON.stringify({ qrcode: 'pending-scan', status: 2 }))
        call.write(event)
      },
      start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => {
        calls++
        if (mode === 'rpc-timeout') { return }
        if (mode === 'rpc-error') { callback({ code: grpc.status.UNAVAILABLE, details: 'initial start rejected' }); return }
        callback(null, new puppet.StartResponse())
        if (calls > 1) { recovered() }
      },
      stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
    })
    const port = await new Promise<number>((resolve, reject): void => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
    })
    if (mode === 'refused') { server.forceShutdown() }
    const service = new TransportService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: true } })
    let timer: NodeJS.Timeout | undefined
    try {
      const waiting = service.waitForTransportStart({ deadline: Date.now() + (mode === 'rpc-timeout' || mode === 'refused' ? 100 : 2000) })
      const outcomes = await Promise.allSettled([ waiting, service.onStart() ])
      const success = mode === 'scan' || mode === 'recovery'
      assert.deepEqual(outcomes.map(result => result.status), success ? [ 'fulfilled', 'fulfilled' ] : [ 'rejected', 'rejected' ])
      assert.equal(service.isLoggedIn, false)
      if (!success) { assert.equal(service.manager, undefined) }
      if (mode === 'rpc-error') {
        for (const result of outcomes) { if (result.status === 'rejected') { assert.match(String(result.reason), /initial start rejected/) } }
      }
      if (mode === 'recovery') {
        stream!.end()
        await Promise.race([ recovery, new Promise<never>((_resolve, reject): void => { timer = setTimeout((): void => { reject(new Error('recovery did not reconnect')) }, 4000) }) ])
        assert.equal(calls, 2)
      }
      t.pass('transport result is independent of login/barrier and preserves established recovery')
    } finally { clearTimeout(timer); await service.cleanup(); server.forceShutdown() }
  })
}

test('deadline during cursor initialization rejects before Start and fences late initialization', async t => {
  const service = new TransportService({ token: `insecure_${randomUUID()}`, recovery: { enabled: true } })
  let entered!: () => void
  const entry = new Promise<void>((resolve): void => { entered = resolve })
  let release!: () => void
  const pending = new Promise<void>((resolve): void => { release = resolve })
  // Hold the actual async boundary before GrpcManager.start, independent of disk speed.
  const position = sinon.stub(service as unknown as ResumePositionReader, 'eventResumePosition').callsFake(async () => {
    entered()
    await bounded(pending)
    return {}
  })
  const start = sinon.stub(GrpcManager.prototype, 'start').resolves()
  const abort = sinon.spy(GrpcManager.prototype, 'abortStartup')
  sinon.stub(GrpcManager.prototype, 'stop').resolves()
  sinon.stub(GrpcManager.prototype, 'stopStream')
  const health = sinon.spy(service, 'startHealthCheck')
  try {
    const starting = service.onStart()
    const started = Promise.allSettled([ starting ])
    await bounded(Promise.race([ entry, starting ]))
    assert.equal(start.callCount, 0)
    await assert.rejects(service.waitForTransportStart({ deadline: Date.now() + 10 }), /deadline/)
    const [ outcome ] = await bounded(started)
    assert.equal(outcome!.status, 'rejected')
    if (outcome!.status === 'rejected') { assert.match(String(outcome!.reason), /deadline/) }
    assert.equal(service.manager, undefined)
    assert.equal(abort.callCount, 1)
    assert.equal(health.callCount, 0)
    release()
    await bounded(new Promise<void>((resolve): void => { setImmediate(resolve) }))
    assert.equal(start.callCount, 0, 'late initialization must not start the abandoned manager')
    assert.equal(service.manager, undefined)
    assert.equal(health.callCount, 0)
    position.restore()
    await bounded(Promise.all([ service.waitForTransportStart({ deadline: Date.now() + 2000 }), service.onStart() ]))
    assert.equal(start.callCount, 1)
    assert.equal(health.callCount, 1)
    t.pass('pre-Start expiry cleans up and a fresh generation can start')
  } finally { release(); try { await bounded(service.cleanup()) } finally { sinon.restore() } }
})

for (const mode of [ 'success', 'failure', 'timeout', 'stop', 'drain', 'legacy-end', 'legacy-cancel' ] as const) {
  test(`transport start contract: ${mode}`, async t => {
    const legacyEvent = mode === 'legacy-end' ? 'end' : mode === 'legacy-cancel' ? 'cancel' : undefined
    const service = new TransportService({ token: `insecure_${randomUUID()}`, recovery: { enabled: !legacyEvent } })
    let entered!: () => void
    const entry = new Promise<void>((resolve): void => { entered = resolve })
    let release!: () => void
    const pending = new Promise<void>((resolve): void => { release = resolve })
    const start = sinon.stub(GrpcManager.prototype, 'start').callsFake(async (): Promise<void> => {
      entered(); await bounded(pending)
      if (mode === 'failure') { throw new Error('initial transport rejected') }
    })
    sinon.stub(GrpcManager.prototype, 'stop').resolves()
    sinon.stub(GrpcManager.prototype, 'stopStream')
    const health = sinon.spy(service, 'startHealthCheck')
    try {
      const waiting = service.waitForTransportStart({ deadline: Date.now() + 2000 })
      const starting = service.onStart()
      const results = Promise.allSettled([ waiting, starting ])
      await bounded(Promise.race([ entry, starting.then((): never => { throw new Error('Start completed without entering the stub') }) ]))
      if (mode === 'timeout') {
        await assert.rejects(service.waitForTransportStart({ deadline: Date.now() + 10 }), /deadline/)
      }
      if (mode === 'stop') { await service.onStop() }
      if (mode === 'drain') { await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 1000 })) }
      if (legacyEvent) { service.grpcManager.emit(legacyEvent); release() }
      if (mode === 'success' || mode === 'failure') { release() }
      const outcomes = await bounded(results)
      assert.deepEqual(outcomes.map(result => result.status), mode === 'success' ? [ 'fulfilled', 'fulfilled' ] : [ 'rejected', 'rejected' ])
      if (mode === 'timeout') {
        for (const outcome of outcomes) { if (outcome.status === 'rejected') { assert.match(String(outcome.reason), /deadline/) } }
      }
      assert.equal(health.callCount, mode === 'success' ? 1 : 0)
      if (mode !== 'success') { assert.equal(service.manager, undefined) }
      release(); await new Promise<void>((resolve): void => { setImmediate(resolve) })
      assert.equal(start.callCount, 1)
      assert.equal(health.callCount, mode === 'success' ? 1 : 0)
      await service.onStop()
      start.resolves()
      await Promise.all([ service.waitForTransportStart({ deadline: Date.now() + 1000 }), service.onStart() ])
      assert.equal(health.callCount, mode === 'success' ? 2 : 1)
      if (legacyEvent) {
        const manager = service.grpcManager
        manager.emit(legacyEvent)
        await service.waitForTransportStart({ deadline: Date.now() + 1000 })
        assert.equal(service.manager, manager, 'established legacy stream behavior is unchanged')
      }
      t.pass('generation invalidation fences late completion; a fresh generation can start')
    } finally { release(); try { await bounded(service.cleanup()) } finally { sinon.restore() } }
  })
}
