import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { grpc, puppet } from '@juzi/wechaty-grpc'
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

test('real logout RPC remains pending in prepare and its delayed rejection is not swallowed', async t => {
  const server = new grpc.Server()
  let accepted!: () => void
  const acceptance = new Promise<void>((resolve): void => { accepted = resolve })
  let rejectLogout!: grpc.sendUnaryData<puppet.LogoutResponse>
  server.addService(puppet.PuppetService, {
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}, 0))
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { callback(null, new puppet.StartResponse()) },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
    logout: (_call: grpc.ServerUnaryCall<puppet.LogoutRequest, puppet.LogoutResponse>, callback: grpc.sendUnaryData<puppet.LogoutResponse>): void => { rejectLogout = callback; accepted() },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const service = new LifecycleService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true } })
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  try {
    await service.onStart()
    const loggedIn = new Promise<void>((resolve): void => { service.once('login', (): void => { resolve() }) })
    service.grpcManager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }))
    await loggedIn
    service.grpcManager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'account', data: 'logout' }, 2))
    await acceptance
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 20 }), /deadline/)
    rejectLogout({ code: grpc.status.UNAVAILABLE, details: 'logout rejected late' })
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 1000 }), /logout rejected late/)
    t.pass('both SDK lifecycle completion and the real RPC failure are part of preparation')
  } finally { await service.cleanup(); sinon.restore(); server.forceShutdown() }
})

test('prepare also awaits async login listeners attached directly to PuppetService', async t => {
  const service = new LifecycleService({ token: `insecure_${randomUUID()}` })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  sinon.stub(service.store, 'start').resolves()
  let release!: () => void
  const application = new Promise<void>((resolve): void => { release = resolve })
  service.on('login', async (): Promise<void> => application)
  service.attach(manager)
  try {
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }))
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 20 }), /deadline/)
    release()
    await service.prepareForRestart({ deadline: Date.now() + 1000 })
    assert.equal(service.isLoggedIn, true)
    t.pass('direct PuppetService listeners are inside the bridge barrier')
  } finally { release(); await service.cleanup(); sinon.restore() }
})

test('late startup cannot resume ownership after stop and concurrent restarts coalesce', async t => {
  const service = new LifecycleService({ token: `insecure_${randomUUID()}` })
  let entered!: () => void
  const entry = new Promise<void>((resolve): void => { entered = resolve })
  let release!: () => void
  const blocked = new Promise<void>((resolve): void => { release = resolve })
  let attempts = 0
  const start = sinon.stub(GrpcManager.prototype, 'start').callsFake(async (): Promise<void> => {
    attempts++
    if (attempts === 1) { entered(); await blocked }
  })
  const stop = sinon.stub(GrpcManager.prototype, 'stop').resolves()
  sinon.stub(GrpcManager.prototype, 'stopStream')
  const health = sinon.spy(service, 'startHealthCheck')
  try {
    const initial = assert.rejects(service.onStart(), /interrupted by stop/)
    await entry
    const oldManager = service.grpcManager
    const stopping = service.onStop()
    const next = service.onStart()
    const duplicate = service.onStart()
    assert.equal(start.callCount, 1)
    release()
    await Promise.all([ initial, stopping, next, duplicate ])
    assert.equal(stop.callCount, 1)
    assert.equal(stop.firstCall.thisValue, oldManager)
    assert.equal(start.callCount, 2)
    assert.notEqual(service.grpcManager, oldManager)
    assert.equal(health.callCount, 1)
    await service.prepareForRestart({ deadline: Date.now() + 1000 })
    t.pass('old startup settles before its channel closes and never re-enables health checks')
  } finally { release(); await service.cleanup(); sinon.restore() }
})

for (const mode of [ 'start', 'logout' ] as const) {
  test(`legacy stop cancels an unresponsive ${mode} RPC before waiting for lifecycle completion`, async t => {
    const server = new grpc.Server()
    let accepted!: () => void
    const acceptance = new Promise<void>((resolve): void => { accepted = resolve })
    server.addService(puppet.PuppetService, {
      event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => { call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}, 0)) },
      start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => {
        if (mode === 'start') { accepted() } else { callback(null, new puppet.StartResponse()) }
      },
      stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
      logout: (): void => { accepted() },
    })
    const port = await new Promise<number>((resolve, reject): void => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
    })
    const service = new LifecycleService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true } })
    sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
    const starting = mode === 'start' ? assert.rejects(service.onStart(), /interrupted by stop/) : service.onStart()
    let stopping: Promise<void> | undefined
    let timer: NodeJS.Timeout | undefined
    try {
      if (mode === 'logout') {
        await starting
        service.login('account')
        service.grpcManager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'account', data: 'logout' }))
      }
      await acceptance
      stopping = service.onStop()
      const completed = await Promise.race([
        stopping.then((): boolean => true),
        new Promise<boolean>((resolve): void => { timer = setTimeout((): void => { resolve(false) }, 200) }),
      ])
      assert.equal(completed, true, 'stop must cancel lifecycle RPCs rather than wait for the server forever')
      t.pass('channel release does not depend on an unresponsive lifecycle RPC')
    } finally {
      clearTimeout(timer); server.forceShutdown()
      await starting; await stopping; await service.cleanup(); sinon.restore()
    }
  })
}
