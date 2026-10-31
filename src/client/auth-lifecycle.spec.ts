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
  test(`cache failure replays after same-account LOGIN, recovery=${recoveryEnabled}`, async t => {
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
      const failed = new Promise<void>((resolve): void => {
        if (recoveryEnabled) { stream.once('cancelled', (): void => { resolve() }) } else { service.once('error', (): void => { resolve() }) }
      })
      stream.write(response(puppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD, { roomId: 'room' }, 2))
      await bounded(failed)
      assert.equal(await service.store.miscellaneous!.get('lastEventSeq'), '1')
      assert.equal(loaded, 0)
      const replayed = new Promise<void>((resolve): void => { service.once('dong', (): void => { resolve() }) })
      if (!recoveryEnabled) { await bounded(service.reset()) }
      await bounded(replayed)
      assert.equal(connections, 2)
      assert.equal(cursors[1], 1)
      assert.equal(logins, 1)
      assert.equal(loaded, 1)
      assert.equal(remove.callCount, 2)
      assert.equal(await service.store.miscellaneous!.get('lastEventSeq'), '2')
      if (recoveryEnabled) { assert.equal(service.recoveryState.status, 'ready') }
      assert.equal(await bounded(service.messageSendText('recipient', 'after replay')), 'sent')
      assert.equal(sends, 1)
      await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /transient cache delete failure/)
      t.pass('replay restores delivery without erasing the sticky restart-drain failure')
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

for (const failure of [ 'conflict', 'sync-listener', 'async-listener', 'store' ] as const) {
  test(`duplicate LOGIN cannot hide ${failure}`, async t => {
    let rejectDelayed!: (error: Error) => void
    const delayed = new Promise<void>((_resolve, reject): void => { rejectDelayed = reject })
    const observed = delayed.catch((): void => {})
    const { service, manager } = fixture(undefined, failure === 'store' ? async (): Promise<void> => delayed : undefined)
    if (failure === 'sync-listener') { service.on('login', (): never => { throw new Error('sync-listener failed') }) }
    if (failure === 'async-listener') { service.on('login', async (): Promise<void> => delayed) }
    try {
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }, 1))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: failure === 'conflict' ? 'B' : 'A' }, 2))
      if (failure === 'store' || failure === 'async-listener') {
        const received = new Promise<void>((resolve): void => { service.once('dong', (): void => { resolve() }) })
        manager.emit('data', response(puppet.EventType.EVENT_TYPE_DONG, { data: 'after-duplicate' }, 3))
        await bounded(received)
      }
      const draining = service.prepareForRestart({ deadline: Date.now() + 2000 })
      rejectDelayed(new Error(`${failure} failed`))
      await assert.rejects(draining, failure === 'conflict' ? /Conflicting LOGIN/ : new RegExp(`${failure} failed`))
      if (failure === 'sync-listener' || failure === 'conflict') {
        assert.equal(await service.store.miscellaneous!.get('lastEventSeq'), failure === 'conflict' ? '1' : undefined)
      }
      await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }))
      t.pass('failure remains sticky across duplicate notifications and repeated drains')
    } finally { rejectDelayed(new Error('cleanup')); await observed; await bounded(service.cleanup()); sinon.restore() }
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
  test(`recovery already logged in validates account, conflict=${conflict}`, async t => {
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
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: conflict ? 'B' : 'A' }, 1))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_READY, {}))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'A', throughSeq: 1 }))
      const dong = new Promise<void>((resolve): void => { service.once('dong', (): void => { resolve() }) })
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_DONG, { data: 'barrier' }))
      if (conflict) {
        await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }))
        assert.equal(await service.store.miscellaneous!.get('lastEventSeq'), undefined)
      } else {
        await bounded(dong)
        await service.prepareForRestart({ deadline: Date.now() + 2000 })
        assert.equal(await service.store.miscellaneous!.get('lastEventSeq'), '1')
      }
      assert.equal(logins, 1); assert.equal(service.currentUserId, 'A')
      t.pass('already logged in never means ignore another account')
    } finally { await bounded(service.cleanup()); sinon.restore() }
  })
}

for (const account of [ 'A', 'B' ]) {
  test(`legacy reconnect validates ${account} on the same manager`, async t => {
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
      const preparing = service.prepareForRestart({ deadline: Date.now() + 2000 })
      if (account === 'A') { await preparing } else { await assert.rejects(preparing, /Conflicting LOGIN|suspended event processing/) }
      assert.equal(service.grpcManager, manager); assert.equal(logins, 1)
      t.pass('stream epoch changes never bypass account validation')
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
    previous.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' }, 2))
    await bounded(entry)
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
