import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { GrpcManager } from './grpc-manager.js'
import { PuppetService } from './puppet-service.js'

class AuthService extends PuppetService {

  attach (manager: GrpcManager): void { this._grpcManager = manager; this.bridgeGrpcEventStream(manager) }
  get store () { return this._payloadStore }
  async cleanup (): Promise<void> { await this.onStop(); await this._payloadStore.destroy() }

}

async function bounded<Result> (operation: Promise<Result>): Promise<Result> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([ operation, new Promise<never>((_resolve, reject): void => {
      timer = setTimeout((): void => { reject(new Error('test barrier timeout')) }, 5000)
    }) ])
  } finally { clearTimeout(timer) }
}

function response (type: ReturnType<puppet.EventResponse['getType']>, payload: unknown, seq = 0): puppet.EventResponse {
  const event = new puppet.EventResponse()
  event.setType(type); event.setPayload(JSON.stringify(payload)); event.setSeq(seq)
  return event
}

async function until (condition: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${label}`) }
    await new Promise<void>((resolve): void => { setTimeout(resolve, 5) })
  }
}

async function snapshotLoginTest (recoveryEnabled: boolean): Promise<void> {
  const server = new grpc.Server()
  let stream!: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>
  let starts = 0
  const login = (): puppet.EventResponse => response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
  server.addService(puppet.PuppetService, {
    event: (call: typeof stream): void => {
      stream = call
      call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {})); call.write(login())
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => {
      starts++
      stream.write(login())
      stream.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
      stream.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'A', throughSeq: 0 }))
      if (starts > 1) { stream.write(response(puppet.EventType.EVENT_TYPE_DONG, { data: 'reconnected' })) }
      callback(null, new puppet.StartResponse())
    },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
  })
  const port = await bounded(new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  }))
  const service = new AuthService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: recoveryEnabled } })
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  let logins = 0
  service.on('login', (): void => { logins++ })
  const received = new Promise<void>((resolve): void => { service.once('dong', (): void => { resolve() }) })
  try {
    await bounded(service.onStart())
    stream.write(response(puppet.EventType.EVENT_TYPE_DONG, { data: 'after-two-logins' }))
    await bounded(received)
    if (recoveryEnabled) {
      const manager = service.grpcManager
      const reconnected = new Promise<void>((resolve): void => { service.once('dong', (): void => { resolve() }) })
      stream.end()
      await bounded(reconnected)
      assert.equal(service.grpcManager, manager); assert.equal(starts, 2)
    }
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.equal(logins, 1); assert.equal(service.currentUserId, 'A')
  } finally { server.forceShutdown(); await bounded(service.cleanup()); sinon.restore() }
}

for (const recoveryEnabled of [ false, true ]) {
  test(`transient cache failure is retried in place without reconnecting, recovery=${recoveryEnabled}`, async t => {
    const server = new grpc.Server()
    let stream!: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>
    let connections = 0
    let sends = 0
    const cursors: number[] = []
    server.addService(puppet.PuppetService, {
      event: (call: typeof stream): void => {
        stream = call
        connections++
        cursors.push(call.request.getSeq())
        call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}))
        call.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }, connections === 1 ? 1 : 0))
        if (connections > 1) { call.write(response(puppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD, { roomId: 'room' }, 2)) }
        call.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
        call.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'A', throughSeq: connections === 1 ? 1 : 2 }))
        call.write(response(puppet.EventType.EVENT_TYPE_DONG, { data: 'processed' }))
      },
      start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { callback(null, new puppet.StartResponse()) },
      stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
      messageSendText: (_call: grpc.ServerUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>, callback: grpc.sendUnaryData<puppet.MessageSendTextResponse>): void => {
        sends++
        const sent = new puppet.MessageSendTextResponse()
        sent.setId('sent')
        callback(null, sent)
      },
    })
    const port = await bounded(new Promise<number>((resolve, reject): void => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
    }))
    const service = new AuthService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: recoveryEnabled } })
    Object.defineProperty(service, 'eventWriteRetryDelays', { value: [ 1, 1, 1 ] })
    sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
    const remove = sinon.stub().onFirstCall().rejects(new Error('transient cache delete failure'))
    remove.onSecondCall().resolves()
    Object.defineProperty(service.store, 'room', { configurable: true, value: { delete: remove } })
    Object.defineProperty(service.store, 'roomMember', { configurable: true, value: { delete: sinon.stub().resolves() } })
    let logins = 0
    let loaded = 0
    service.on('login', (): void => { logins++ })
    service.on('room-member-load', (): void => { loaded++ })
    const initial = new Promise<void>((resolve): void => { service.once('dong', (): void => { resolve() }) })
    try {
      await bounded(service.onStart())
      await bounded(initial)
      assert.equal(service.currentUserId, 'A')
      const errors = sinon.spy()
      service.on('error', errors)
      const after = new Promise<void>((resolve): void => { service.once('dong', (): void => { resolve() }) })
      stream.write(response(puppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD, { roomId: 'room' }, 2))
      stream.write(response(puppet.EventType.EVENT_TYPE_DONG, { data: 'after' }, 3))
      await bounded(after)
      assert.equal(connections, 1, 'no reconnect')
      assert.equal(logins, 1)
      assert.equal(loaded, 1, 'the listener ran exactly once')
      assert.equal(remove.callCount, 2)
      assert.equal(errors.callCount, 0)
      if (recoveryEnabled) { assert.equal(service.recoveryState.status, 'ready') }
      assert.equal(await bounded(service.messageSendText('recipient', 'after retry')), 'sent')
      assert.equal(sends, 1)
      await service.prepareForRestart({ deadline: Date.now() + 2000 })
      assert.equal(await service.store.miscellaneous!.get('lastEventSeq'), '3')
      assert.deepEqual(cursors, [ 0 ])
      t.pass('the stream keeps flowing through a transient write failure')
    } finally { server.forceShutdown(); await bounded(service.cleanup()); sinon.restore() }
  })

  test(`Event snapshot plus Start LOGIN is idempotent, recovery=${recoveryEnabled}`, async t => {
    await snapshotLoginTest(recoveryEnabled)
    t.pass('duplicate notification and recovery reconnect leave a clean drain')
  })
}

test('real gRPC logout listener can await public logout while echoed LOGOUT RPCs drain', async t => {
  const server = new grpc.Server()
  let stream!: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>
  let logoutCalls = 0
  let releaseDerivedRpc: (() => void) | undefined
  let derivedRpcEntered!: () => void
  const derivedRpc = new Promise<void>((resolve): void => { derivedRpcEntered = resolve })
  server.addService(puppet.PuppetService, {
    event: (call: typeof stream): void => {
      stream = call
      call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}))
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => {
      stream.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      stream.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
      callback(null, new puppet.StartResponse())
    },
    logout: (_call: grpc.ServerUnaryCall<puppet.LogoutRequest, puppet.LogoutResponse>, callback: grpc.sendUnaryData<puppet.LogoutResponse>): void => {
      logoutCalls++
      // Model one in-flight duplicate notification, not an echo for every RPC.
      // The server delegates to puppet.logout(); the base Puppet stops emitting
      // once logged out. An adapter that always emits would create a feedback loop.
      if (logoutCalls === 1) {
        stream.write(response(puppet.EventType.EVENT_TYPE_LOGOUT, { data: 'server echo' }))
        stream.write(response(puppet.EventType.EVENT_TYPE_DONG, { data: 'echo processed' }))
      }
      if (logoutCalls === 3) {
        releaseDerivedRpc = (): void => { callback(null, new puppet.LogoutResponse()) }
        derivedRpcEntered()
        return
      }
      callback(null, new puppet.LogoutResponse())
    },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
  })
  const port = await bounded(new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  }))
  const service = new AuthService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true } })
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  const ready = new Promise<void>((resolve): void => { service.once('ready', (): void => { resolve() }) })
  const echoProcessed = new Promise<void>((resolve): void => { service.once('dong', (): void => { resolve() }) })
  let listenerCompleted!: () => void
  const listenerDone = new Promise<void>((resolve): void => { listenerCompleted = resolve })
  let logoutEvents = 0
  service.on('logout', async (): Promise<void> => {
    logoutEvents++
    assert.equal(logoutEvents, 1, 'logout must not recursively emit')
    await service.logout('listener reentry')
    listenerCompleted()
  })
  try {
    await bounded(service.onStart())
    await bounded(ready)
    assert.equal(service.currentUserId, 'A')
    stream.write(response(puppet.EventType.EVENT_TYPE_LOGOUT, { data: 'remote logout' }))
    await bounded(Promise.all([ listenerDone, echoProcessed, derivedRpc ]))
    assert.equal(service.isLoggedIn, false)
    assert.equal(logoutEvents, 1)
    assert.equal(logoutCalls, 3, 'remote logout, listener reentry and server echo each issue one RPC')
    await bounded(assert.rejects(service.prepareForRestart({ deadline: Date.now() + 20 }), /deadline/))
    assert.ok(releaseDerivedRpc)
    releaseDerivedRpc()
    releaseDerivedRpc = undefined
    await bounded(service.prepareForRestart({ deadline: Date.now() + 2000 }))
    assert.equal(logoutEvents, 1)
    assert.equal(logoutCalls, 3)
    t.pass('listener completes without recursion or deadlock, but derived RPC still blocks restart')
  } finally {
    releaseDerivedRpc?.()
    server.forceShutdown()
    await bounded(service.cleanup())
    sinon.restore()
  }
})

function fixture (logout: () => Promise<void> = async (): Promise<void> => {}, startStore: () => Promise<void> = async (): Promise<void> => {}): { service: AuthService, manager: GrpcManager } {
  const service = new AuthService({ token: `insecure_${randomUUID()}` })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves(); sinon.stub(manager, 'logout').callsFake(logout)
  sinon.stub(service.store, 'start').callsFake(startStore); sinon.stub(service.store, 'stop').resolves()
  service.attach(manager)
  return { service, manager }
}

for (const target of [ 'A', 'B' ]) {
  test(`A -> LOGOUT -> ${target} serializes real local logout without blocking on RPC`, async t => {
    let release!: () => void
    const rpc = new Promise<void>((resolve): void => { release = resolve })
    const { service, manager } = fixture(async (): Promise<void> => rpc)
    const events: string[] = []
    service.on('login', ({ contactId }): void => { events.push(`login:${contactId}`) })
    service.on('logout', (): void => { events.push(`logout:${service.currentUserId}`) })
    const ready = new Promise<void>((resolve): void => { service.once('ready', (): void => { resolve() }) })
    try {
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { data: 'remote logout' }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: target }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_READY, {}))
      await bounded(ready)
      assert.deepEqual(events, [ 'login:A', 'logout:A', `login:${target}` ])
      assert.equal(service.currentUserId, target)
      await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 20 }), /deadline/)
      release()
      await service.prepareForRestart({ deadline: Date.now() + 2000 })
      t.pass('RPC is drained separately from ordered authentication state')
    } finally { release(); await bounded(service.cleanup()); sinon.restore() }
  })
}

for (const failure of [ 'sync-listener', 'async-listener', 'store' ] as const) {
  test(`a failed ${failure} never blocks a later LOGIN or the stream`, async t => {
    let rejectDelayed!: (error: Error) => void
    const delayed = new Promise<void>((_resolve, reject): void => { rejectDelayed = reject })
    const observed = delayed.catch((): void => {})
    const { service, manager } = fixture(undefined, failure === 'store' ? async (): Promise<void> => delayed : undefined)
    service.on('error', (): void => {})
    let throwOnce = failure === 'sync-listener'
    if (failure === 'sync-listener') { service.on('login', (): void => { if (throwOnce) { throwOnce = false; throw new Error('sync-listener failed') } }) }
    if (failure === 'async-listener') { service.once('login', async (): Promise<void> => delayed) }
    try {
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }, 1))
      const received = new Promise<void>((resolve): void => { service.once('dong', (): void => { resolve() }) })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_DONG, { data: 'after-failure' }, 2))
      await bounded(received)
      rejectDelayed(new Error(`${failure} failed`))
      await bounded(observed)
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'kicked' }))
      const relogin = new Promise<void>((resolve): void => { service.once('login', (): void => { resolve() }) })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }, 3))
      await bounded(relogin)
      assert.equal(service.currentUserId, 'A')
      if (failure === 'store') {
        await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /store failed/)
      } else {
        await service.prepareForRestart({ deadline: Date.now() + 2000 })
      }
      t.pass('only SDK lifecycle (store) failures reach restart preparation; none refuses LOGIN')
    } finally { rejectDelayed(new Error('cleanup')); await observed; await bounded(service.cleanup()); sinon.restore() }
  })
}

for (const recoveryEnabled of [ false, true ]) {
  test(`LOGIN B without LOGOUT logs A out locally first, recovery=${recoveryEnabled}`, async t => {
    const service = new AuthService({ token: `insecure_${randomUUID()}`, recovery: { enabled: recoveryEnabled } })
    sinon.stub(GrpcManager.prototype, 'start').resolves(); sinon.stub(GrpcManager.prototype, 'stop').resolves(); sinon.stub(GrpcManager.prototype, 'stopStream')
    const stores: string[] = []
    sinon.stub(service.store, 'start').callsFake(async (id: string): Promise<void> => { stores.push(`start:${id}`) })
    sinon.stub(service.store, 'stop').callsFake(async (): Promise<void> => { stores.push('stop') })
    const events: string[] = []
    service.on('login', ({ contactId }): void => { events.push(`login:${contactId}`) })
    service.on('logout', ({ contactId }): void => { events.push(`logout:${contactId}`) })
    try {
      await bounded(service.onStart())
      const manager = service.grpcManager
      const loggedInB = new Promise<void>((resolve): void => { service.on('login', ({ contactId }): void => { if (contactId === 'B') { resolve() } }) })
      const loggedInA = new Promise<void>((resolve): void => { service.once('login', (): void => { resolve() }) })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_READY, {}))
      if (recoveryEnabled) { manager.emit('data', response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'A', throughSeq: 0 })) }
      await bounded(loggedInA)
      await new Promise<void>((resolve): void => { setTimeout(resolve, 20) })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' }))
      await bounded(loggedInB)
      assert.deepEqual(events, [ 'login:A', 'logout:A', 'login:B' ])
      assert.equal(service.currentUserId, 'B')
      await service.prepareForRestart({ deadline: Date.now() + 2000 })
      assert.deepEqual(stores, [ 'start:A', 'stop', 'start:B' ])
      assert.equal(await service.store.miscellaneous!.get('accountId'), 'B')
      if (recoveryEnabled) { assert.equal(service.recoveryState.status, 'ready') }
      t.pass('the account switch is applied, never refused')
    } finally { await bounded(service.cleanup()); sinon.restore() }
  })
}

test('positive-sequence duplicate LOGIN commits in event order without duplicate listeners', async t => {
  const { service, manager } = fixture()
  const events: string[] = []
  service.on('login', (): void => { events.push('login') })
  service.on('dong', (): void => { events.push('dong') })
  try {
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }, 1))
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }, 2))
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_DONG, { data: 'ordered' }, 3))
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.deepEqual(events, [ 'login', 'dong' ])
    assert.equal(await service.store.miscellaneous!.get('lastEventSeq'), '3')
    t.pass('deduplication does not bypass the checkpoint path')
  } finally { await bounded(service.cleanup()); sinon.restore() }
})

for (const conflict of [ false, true ]) {
  test(`recovery replay switches to a new session on another account, conflict=${conflict}`, async t => {
    const service = new AuthService({ token: `insecure_${randomUUID()}`, recovery: { enabled: true } })
    sinon.stub(GrpcManager.prototype, 'start').resolves(); sinon.stub(GrpcManager.prototype, 'stop').resolves(); sinon.stub(GrpcManager.prototype, 'stopStream')
    sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
    let logins = 0
    service.on('login', (): void => { logins++ })
    try {
      await bounded(service.onStart())
      const manager = service.grpcManager
      const loggedIn = new Promise<void>((resolve): void => { service.once('login', (): void => { resolve() }) })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      await bounded(loggedIn)
      const account = conflict ? 'B' : 'A'
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: account }, 1))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_READY, {}))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: account, throughSeq: 1 }))
      const dong = new Promise<void>((resolve): void => { service.once('dong', (): void => { resolve() }) })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_DONG, { data: 'barrier' }))
      await bounded(dong)
      assert.equal(service.recoveryState.status, 'ready')
      await service.prepareForRestart({ deadline: Date.now() + 2000 })
      assert.equal(await service.store.miscellaneous!.get('lastEventSeq'), '1')
      assert.equal(logins, conflict ? 2 : 1); assert.equal(service.currentUserId, account)
      t.pass('another account becomes a new session instead of being refused')
    } finally { await bounded(service.cleanup()); sinon.restore() }
  })
}

for (const account of [ 'A', 'B' ]) {
  test(`legacy reconnect accepts ${account} on the same manager`, async t => {
    const { service, manager } = fixture()
    let logins = 0
    service.on('login', (): void => { logins++ })
    service.login('A')
    sinon.stub(manager, 'startStream').callsFake(async (): Promise<void> => {
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: account }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: account }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_READY, {}))
    })
    try {
      await bounded(service.reset())
      await new Promise<void>((resolve): void => { setImmediate(resolve) })
      await service.prepareForRestart({ deadline: Date.now() + 2000 })
      assert.equal(service.grpcManager, manager)
      assert.equal(logins, account === 'A' ? 1 : 2)
      assert.equal(service.currentUserId, account)
      t.pass('a reconnect that reports another account switches to it')
    } finally { await bounded(service.cleanup()); sinon.restore() }
  })
}

test('public logout still executes during suspended recovery', async t => {
  const service = new AuthService({ token: `insecure_${randomUUID()}`, recovery: { enabled: true } })
  sinon.stub(GrpcManager.prototype, 'start').resolves(); sinon.stub(GrpcManager.prototype, 'stop').resolves(); sinon.stub(GrpcManager.prototype, 'stopStream')
  const logout = sinon.stub(GrpcManager.prototype, 'logout').resolves()
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  try {
    await bounded(service.onStart())
    service.login('A')
    service.grpcManager.emit('end')
    await bounded(service.logout('user request'))
    assert.equal(service.isLoggedIn, false); assert.equal(logout.callCount, 1)
    assert.equal(service.recoveryState.status, 'offline')
    t.pass('an external logout is generation-bound, not stream-bound')
  } finally { await bounded(service.cleanup()); sinon.restore() }
})

test('stop/start fences authentication waiting on old metadata and queued old LOGIN', async t => {
  const service = new AuthService({ token: `insecure_${randomUUID()}` })
  sinon.stub(GrpcManager.prototype, 'start').resolves(); sinon.stub(GrpcManager.prototype, 'stop').resolves(); sinon.stub(GrpcManager.prototype, 'stopStream')
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  let entered!: () => void
  const entry = new Promise<void>((resolve): void => { entered = resolve })
  let release!: () => void
  const blocked = new Promise<void>((resolve): void => { release = resolve })
  const store = service.store.miscellaneous!
  const original = store.set.bind(store)
  sinon.stub(store, 'set').callsFake(async (key, value): ReturnType<typeof original> => {
    if (key === 'accountId' && value === 'A') { entered(); await blocked }
    return original(key, value)
  })
  const accounts: string[] = []
  service.on('login', ({ contactId }): void => { accounts.push(contactId) })
  try {
    await bounded(service.onStart())
    const previous = service.grpcManager
    previous.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }, 1))
    await bounded(entry)
    previous.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' }, 2))
    const stopping = service.onStop()
    const starting = service.onStart()
    release()
    await bounded(Promise.all([ stopping, starting ]))
    assert.notEqual(service.grpcManager, previous)
    previous.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' }, 3))
    service.grpcManager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'C' }, 1))
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.deepEqual(accounts, [ 'C' ]); assert.equal(service.currentUserId, 'C')
    assert.equal(await store.get('accountId'), 'C')
    t.pass('old authentication cannot emit or overwrite the next start')
  } finally { release(); await bounded(service.cleanup()); sinon.restore() }
})

test('public logout RPC is also drained and retains a delayed rejection', async t => {
  let entered!: () => void
  const entry = new Promise<void>((resolve): void => { entered = resolve })
  let rejectRpc!: (error: Error) => void
  const rpc = new Promise<void>((_resolve, reject): void => { rejectRpc = reject })
  const { service } = fixture(async (): Promise<void> => { entered(); await rpc })
  try {
    service.login('A')
    const logout = assert.rejects(service.logout('user logout'), /public logout failure/)
    await bounded(entry)
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 20 }), /deadline/)
    rejectRpc(new Error('public logout failure'))
    await bounded(logout)
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /public logout failure/)
    t.pass('external authentication RPCs cannot escape the SDK drain')
  } finally { rejectRpc(new Error('cleanup')); await bounded(service.cleanup()); sinon.restore() }
})

for (const target of [ 'A', 'B' ]) {
  test(`server LOGOUT whose echoed logout RPC fails still admits the next LOGIN ${target}`, async t => {
    let rejected!: () => void
    const rpcRejected = new Promise<void>((resolve): void => { rejected = resolve })
    const { service, manager } = fixture(async (): Promise<void> => {
      rejected()
      throw new Error('13 INTERNAL: vid not signed')
    })
    const logins: string[] = []
    service.on('login', ({ contactId }): void => { logins.push(contactId) })
    try {
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'kicked by server' }))
      await bounded(rpcRejected)
      await new Promise<void>((resolve): void => { setImmediate(resolve) })
      const loggedIn = new Promise<void>((resolve): void => { service.once('login', (): void => { resolve() }) })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: target }))
      await bounded(loggedIn)
      assert.deepEqual(logins, [ 'A', target ])
      assert.equal(service.isLoggedIn, true)
      assert.equal(service.currentUserId, target)
      t.pass('a rejected echo of an already-ended session does not block re-login')
    } finally { await bounded(service.cleanup()); sinon.restore() }
  })
}

test('server LOGOUT whose echoed logout RPC fails does not fail restart preparation', async t => {
  let rejected!: () => void
  const rpcRejected = new Promise<void>((resolve): void => { rejected = resolve })
  const { service, manager } = fixture(async (): Promise<void> => {
    rejected()
    throw new Error('13 INTERNAL: vid not signed')
  })
  try {
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'kicked by server' }))
    await bounded(rpcRejected)
    await bounded(service.prepareForRestart({ deadline: Date.now() + 2000 }))
    assert.equal(service.isLoggedIn, false)
    t.pass('the echo is drained, logged and not mistaken for lost work')
  } finally { await bounded(service.cleanup()); sinon.restore() }
})

test('public logout RPC failure is returned to the caller without rejecting the next LOGIN', async t => {
  const { service, manager } = fixture(async (): Promise<void> => { throw new Error('public logout failure') })
  try {
    service.login('A')
    await assert.rejects(bounded(service.logout('user logout')), /public logout failure/)
    const loggedIn = new Promise<void>((resolve): void => { service.once('login', (): void => { resolve() }) })
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
    await bounded(loggedIn)
    assert.equal(service.currentUserId, 'A')
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /public logout failure/)
    t.pass('caller-visible logout failure stays sticky for drain, not authentication')
  } finally { await bounded(service.cleanup()); sinon.restore() }
})

test('recovery=true: LOGOUT then LOGIN A or B on the same stream opens a live session', async t => {
  for (const next of [ 'A', 'B' ]) {
    const service = new AuthService({ token: `insecure_${randomUUID()}`, recovery: { enabled: true } })
    sinon.stub(GrpcManager.prototype, 'start').resolves(); sinon.stub(GrpcManager.prototype, 'stop').resolves()
    const stopStream = sinon.stub(GrpcManager.prototype, 'stopStream')
    sinon.stub(GrpcManager.prototype, 'logout').rejects(new Error('13 INTERNAL: vid not signed'))
    sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
    const scans: unknown[] = []
    service.on('scan', (payload): void => { scans.push(payload) })
    try {
      await bounded(service.onStart())
      const manager = service.grpcManager
      const ready = new Promise<void>((resolve): void => { service.once('ready', (): void => { resolve() }) })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_READY, {}))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'A', throughSeq: 0 }))
      await bounded(ready)
      await until((): boolean => service.recoveryState.status === 'ready', 'initial barrier')
      const queuedForA = service.withRecoveryRequestContext({ deadline: Date.now() + 2000 }, async (): Promise<void> => {
        await new Promise<void>((resolve): void => { setImmediate(resolve) })
      })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'kicked' }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_SCAN, { status: 2, qrcode: 'qr' }))
      const relogin = new Promise<void>((resolve): void => { service.once('login', (): void => { resolve() }) })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: next }))
      await bounded(relogin)
      await queuedForA
      await until((): boolean => service.recoveryState.status === 'ready', 'live session')
      assert.equal(scans.length, 1, 'SCAN after LOGOUT is delivered')
      assert.equal(service.currentUserId, next)
      assert.equal(service.recoveryState.status, 'ready', 'no barrier follows on this stream')
      assert.equal(stopStream.callCount, 0, 'the stream is never halted')
      await service.prepareForRestart({ deadline: Date.now() + 2000 })
      t.pass(`re-login as ${next} is accepted`)
    } finally { await bounded(service.cleanup()); sinon.restore() }
  }
})

test('recovery=true: a request queued before LOGOUT is never sent for the next session', async t => {
  const service = new AuthService({ token: `insecure_${randomUUID()}`, recovery: { enabled: true } })
  sinon.stub(GrpcManager.prototype, 'start').resolves(); sinon.stub(GrpcManager.prototype, 'stop').resolves(); sinon.stub(GrpcManager.prototype, 'stopStream')
  sinon.stub(GrpcManager.prototype, 'logout').resolves()
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  try {
    await bounded(service.onStart())
    const manager = service.grpcManager
    // Recovering: requests wait for the gate.
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
    await until((): boolean => service.isLoggedIn, 'login A')
    assert.equal(service.recoveryState.status, 'recovering')
    const waiting = (service as unknown as { recovery: { wait: () => Promise<void> } }).recovery.wait()
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'kicked' }))
    await assert.rejects(bounded(waiting), /logged out/)
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' }))
    await until((): boolean => service.isLoggedIn && service.currentUserId === 'B', 'login B')
    await until((): boolean => service.recoveryState.status === 'ready', 'live session')
    t.pass('requests admitted for A are rejected, B starts clean')
  } finally { await bounded(service.cleanup()); sinon.restore() }
})

test('recovery=true: a mismatched or invalid barrier reconnects instead of going offline', async t => {
  for (const barrier of [ { accountId: 'B', throughSeq: 0 }, { accountId: 'A', throughSeq: 99 }, { bad: true } ]) {
    const service = new AuthService({ token: `insecure_${randomUUID()}`, recovery: { enabled: true } })
    sinon.stub(GrpcManager.prototype, 'start').resolves(); sinon.stub(GrpcManager.prototype, 'stop').resolves()
    const stopStream = sinon.stub(GrpcManager.prototype, 'stopStream')
    const startStream = sinon.stub(GrpcManager.prototype, 'startStream').resolves()
    sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
    try {
      await bounded(service.onStart())
      const manager = service.grpcManager
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_READY, {}))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, barrier))
      await new Promise<void>((resolve): void => { setTimeout(resolve, 1300) })
      assert.equal(service.recoveryState.status, 'recovering', JSON.stringify(barrier))
      assert.ok(stopStream.callCount >= 1)
      assert.ok(startStream.callCount >= 1, 'a reconnect was requested')
    } finally { await bounded(service.cleanup()); sinon.restore() }
  }
  t.pass('barrier problems retry within the recovery budget')
})

test('LOGIN still logs in when its metadata write keeps failing', async t => {
  for (const recoveryEnabled of [ false, true ]) {
    const service = new AuthService({ token: `insecure_${randomUUID()}`, recovery: { enabled: recoveryEnabled } })
    Object.defineProperty(service, 'eventWriteRetryDelays', { value: [ 1, 1, 1 ] })
    sinon.stub(GrpcManager.prototype, 'start').resolves(); sinon.stub(GrpcManager.prototype, 'stop').resolves(); sinon.stub(GrpcManager.prototype, 'stopStream')
    sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
    service.on('error', (): void => {})
    try {
      await bounded(service.onStart())
      const set = sinon.stub(service.store.miscellaneous!, 'set').rejects(new Error('metadata write failed'))
      const manager = service.grpcManager
      const loggedIn = new Promise<void>((resolve): void => { service.once('login', (): void => { resolve() }) })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      await bounded(loggedIn)
      assert.equal(service.currentUserId, 'A')
      assert.ok(set.callCount >= 4, 'the metadata write was retried')
      if (recoveryEnabled) { assert.equal(service.recoveryState.status, 'recovering', 'the gate still waits for the barrier') }
    } finally { await bounded(service.cleanup()); sinon.restore() }
  }
  t.pass('a cursor write failure never refuses a login')
})

test('a throwing logout listener still ends the local session and the next LOGIN is accepted', async t => {
  const { service, manager } = fixture()
  service.on('error', (): void => {})
  let throwing = true
  service.on('logout', (): void => { if (throwing) { throwing = false; throw new Error('logout listener failed') } })
  try {
    const loggedIn = new Promise<void>((resolve): void => { service.once('login', (): void => { resolve() }) })
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
    await bounded(loggedIn)
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'kicked' }))
    const relogin = new Promise<void>((resolve): void => { service.on('login', ({ contactId }): void => { if (contactId === 'B') { resolve() } }) })
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' }))
    await bounded(relogin)
    assert.equal(service.currentUserId, 'B')
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    t.pass('a listener failure cannot leave the account logged in')
  } finally { await bounded(service.cleanup()); sinon.restore() }
})

test('LOGIN B replacing A still logs in when a logout listener throws', async t => {
  const { service, manager } = fixture()
  service.on('error', (): void => {})
  service.once('logout', (): never => { throw new Error('logout listener failed') })
  try {
    const loggedIn = new Promise<void>((resolve): void => { service.once('login', (): void => { resolve() }) })
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
    await bounded(loggedIn)
    const loggedInB = new Promise<void>((resolve): void => { service.on('login', ({ contactId }): void => { if (contactId === 'B') { resolve() } }) })
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' }))
    await bounded(loggedInB)
    assert.equal(service.currentUserId, 'B')
    t.pass('the switch completes despite the listener failure')
  } finally { await bounded(service.cleanup()); sinon.restore() }
})
