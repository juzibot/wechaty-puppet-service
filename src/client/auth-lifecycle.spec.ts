import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import * as PUPPET from '@juzi/wechaty-puppet'
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

test('real gRPC logout listener can explicitly logout without echoing either notification', async t => {
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
      if (logoutCalls === 1) {
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
    await bounded(Promise.all([ echoProcessed, derivedRpc ]))
    assert.equal(service.isLoggedIn, false)
    assert.equal(logoutEvents, 1)
    assert.equal(logoutCalls, 1, 'only the explicit listener call issues an RPC')
    await bounded(assert.rejects(service.prepareForRestart({ deadline: Date.now() + 20 }), /deadline/))
    assert.ok(releaseDerivedRpc)
    releaseDerivedRpc()
    releaseDerivedRpc = undefined
    await bounded(listenerDone)
    await bounded(service.prepareForRestart({ deadline: Date.now() + 2000 }))
    assert.equal(logoutEvents, 1)
    assert.equal(logoutCalls, 1)
    t.pass('listener completes without recursion or deadlock, but derived RPC still blocks restart')
  } finally {
    releaseDerivedRpc?.()
    server.forceShutdown()
    await bounded(service.cleanup())
    sinon.restore()
  }
})

function fixture (logout: () => Promise<void> = async (): Promise<void> => {}, startStore: () => Promise<void> = async (): Promise<void> => {}, recoveryEnabled = false): { service: AuthService, manager: GrpcManager } {
  const service = new AuthService({ token: `insecure_${randomUUID()}`, recovery: { enabled: recoveryEnabled } })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves(); sinon.stub(manager, 'logout').callsFake(logout)
  sinon.stub(service.store, 'start').callsFake(startStore); sinon.stub(service.store, 'stop').resolves()
  service.attach(manager)
  return { service, manager }
}

function deferred (): { promise: Promise<void>, resolve: () => void } {
  let complete!: () => void
  const promise = new Promise<void>((resolve): void => { complete = resolve })
  return { promise, resolve: complete }
}

async function flushStream (service: AuthService, manager: GrpcManager): Promise<void> {
  const drained = deferred()
  service.once('dong', drained.resolve)
  manager.emit('data', response(puppet.EventType.EVENT_TYPE_DONG, { data: 'drain' }))
  await bounded(drained.promise)
}

for (const recoveryEnabled of [ false, true ]) {
  for (const waitAt of [ 'queued', 'metadata', 'listener' ] as const) {
    test(`same-account LOGIN supersedes old stream LOGOUT at ${waitAt}, recovery=${recoveryEnabled}`, async t => {
      let logoutCalls = 0
      const { service, manager } = fixture(async (): Promise<void> => { logoutCalls++ }, undefined, recoveryEnabled)
      const login = response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
      const logout = response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'previous session' })
      const entered = deferred()
      const release = deferred()
      let localLogouts = 0
      service.on('logout', (): void => { localLogouts++ })
      try {
        manager.emit('data', login)
        await flushStream(service, manager)
        assert.equal(service.currentUserId, 'A')

        const store = service.store.miscellaneous!
        const get = store.get.bind(store)
        const remove = sinon.spy(store, 'delete')
        if (waitAt === 'metadata') {
          sinon.stub(store, 'get').callsFake(async (key: string): Promise<string | undefined> => {
            entered.resolve()
            await release.promise
            return get(key)
          })
        }
        if (waitAt === 'listener') {
          service.once('logout', (): void => { manager.emit('data', login) })
        }
        manager.emit('data', logout)
        if (waitAt === 'metadata') { await bounded(entered.promise) }
        if (waitAt !== 'listener') { manager.emit('data', login) }
        release.resolve()
        await flushStream(service, manager)
        if (waitAt === 'listener') { await flushStream(service, manager) }

        assert.equal(logoutCalls, 0, 'no stale Logout RPC')
        assert.equal(localLogouts, waitAt === 'listener' ? 1 : 0)
        if (waitAt !== 'listener') { assert.equal(remove.callCount, 0, 'no stale cursor reset') }
        assert.equal(service.currentUserId, 'A')
        assert.equal(await store.get('accountId'), 'A')
        if (recoveryEnabled) { assert.equal(service.recoveryState.status, 'ready') }

        manager.emit('data', logout)
        await flushStream(service, manager)
        assert.equal(service.isLoggedIn, false, 'a current server LOGOUT still logs out locally')
        assert.equal(logoutCalls, 0, 'a current server LOGOUT is notification only')
        manager.emit('data', login)
        await flushStream(service, manager)
        await service.logout('user request')
        assert.equal(service.isLoggedIn, false)
        assert.equal(logoutCalls, 1, 'explicit logout still submits its own RPC')
        t.pass('only the superseded server event loses ownership')
      } finally {
        release.resolve()
        await bounded(service.cleanup())
        sinon.restore()
      }
    })
  }

  test(`a different LOGIN keeps the prior server logout reason without echoing it, recovery=${recoveryEnabled}`, async t => {
    let logoutCalls = 0
    const { service, manager } = fixture(async (): Promise<void> => { logoutCalls++ }, undefined, recoveryEnabled)
    const reasons: string[] = []
    service.on('logout', ({ data }): void => { if (data) { reasons.push(data) } })
    try {
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      await flushStream(service, manager)
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'kicked by server' }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' }))
      await flushStream(service, manager)
      assert.deepEqual(reasons, [ 'kicked by server' ])
      assert.equal(logoutCalls, 0)
      assert.equal(service.currentUserId, 'B')
      t.pass('preserve local notification without logging the next account out remotely')
    } finally { await bounded(service.cleanup()); sinon.restore() }
  })

  test(`a late named LOGOUT cannot fence the next account, recovery=${recoveryEnabled}`, async t => {
    const { service, manager } = fixture(undefined, undefined, recoveryEnabled)
    const transport = sinon.stub(service, 'cancelEndpointReplacement')
    let localLogouts = 0
    service.on('logout', (): void => { localLogouts++ })
    try {
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }, 1))
      await flushStream(service, manager)
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' }, 2))
      await flushStream(service, manager)
      const gate = Reflect.get(service, 'recovery') as { session: number }
      const session = gate.session
      const priorLogouts = localLogouts
      transport.resetHistory()
      for (const contactId of [ 'A', 42, null, '', '   ' ]) {
        manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId }, 3))
        await flushStream(service, manager)
        assert.equal(gate.session, session, `no cancellation of B requests for ${JSON.stringify(contactId)}`)
        assert.equal(localLogouts, priorLogouts)
        assert.equal(transport.callCount, 0)
        assert.equal(service.currentUserId, 'B')
        assert.equal(await service.store.miscellaneous!.get('lastEventSeq'), '2')
        if (recoveryEnabled) { assert.equal(service.recoveryState.status, 'ready') }
      }
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { data: 'legacy notification' }))
      await flushStream(service, manager)
      assert.equal(localLogouts, priorLogouts + 1)
      assert.equal(service.isLoggedIn, false)
      t.pass('only a missing contactId uses legacy arrival order')
    } finally { await bounded(service.cleanup()); sinon.restore() }
  })

  test(`LOGOUT cannot clear the cursor while waiting for the auth queue, recovery=${recoveryEnabled}`, async t => {
    const { service, manager } = fixture(undefined, undefined, recoveryEnabled)
    const held = deferred()
    const dispatching = deferred()
    const login = response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
    const store = service.store.miscellaneous!
    const auth = service as unknown as {
      authenticationQueue: Promise<void>,
      enqueueAuthentication: (epoch: number, operation: () => Promise<void>, eventBound?: boolean) => Promise<void>,
    }
    try {
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }, 1))
      await flushStream(service, manager)
      auth.authenticationQueue = held.promise
      const enqueue = auth.enqueueAuthentication.bind(auth)
      sinon.stub(auth, 'enqueueAuthentication').callsFake((epoch, operation, eventBound): Promise<void> => {
        dispatching.resolve()
        return enqueue(epoch, operation, eventBound)
      })
      const removed = sinon.spy(store, 'delete')
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A' }, 2))
      await bounded(dispatching.promise)
      assert.equal(await store.get('lastEventSeq'), '1')
      manager.emit('data', login)
      held.resolve()
      await flushStream(service, manager)
      assert.equal(removed.callCount, 0)
      assert.equal(await store.get('lastEventSeq'), '1')
      assert.equal(service.currentUserId, 'A')
      t.pass('the invalidated logout never acquires the right to clear metadata')
    } finally { held.resolve(); await bounded(service.cleanup()); sinon.restore() }
  })

  test(`malformed LOGIN cannot revoke a valid logout pending submission, recovery=${recoveryEnabled}`, async t => {
    let logoutCalls = 0
    const { service, manager } = fixture(async (): Promise<void> => { logoutCalls++ }, undefined, recoveryEnabled)
    service.on('error', (): void => {})
    service.once('logout', (): void => {
      for (const payload of [ {}, { contactId: null }, { contactId: '' }, { contactId: 42 } ]) {
        manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, payload))
      }
    })
    try {
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      await flushStream(service, manager)
      await bounded(service.logout('user request'))
      await flushStream(service, manager)
      assert.equal(logoutCalls, 1)
      assert.equal(service.isLoggedIn, false)
      t.pass('only a valid LOGIN can revoke an unsubmitted logout')
    } finally { await bounded(service.cleanup()); sinon.restore() }
  })

  test(`a queued public logout cannot act after same-account LOGIN, recovery=${recoveryEnabled}`, async t => {
    let logoutCalls = 0
    let localLogouts = 0
    const { service, manager } = fixture(async (): Promise<void> => { logoutCalls++ }, undefined, recoveryEnabled)
    const login = response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
    const held = deferred()
    service.on('logout', (): void => { localLogouts++ })
    try {
      manager.emit('data', login)
      await flushStream(service, manager)
      Reflect.set(service, 'authenticationQueue', held.promise)
      const rejected = assert.rejects(service.logout('old request'), /Superseded logout request/)
      manager.emit('data', login)
      held.resolve()
      await bounded(rejected)
      await flushStream(service, manager)
      assert.equal(localLogouts, 0)
      assert.equal(logoutCalls, 0)
      assert.equal(service.currentUserId, 'A')

      await bounded(service.logout('current request'))
      assert.equal(localLogouts, 1)
      assert.equal(logoutCalls, 1)
      assert.equal(service.isLoggedIn, false)
      t.pass('the fence is captured before entering the authentication queue')
    } finally { held.resolve(); await bounded(service.cleanup()); sinon.restore() }
  })

  test(`same-account LOGIN during public local logout prevents its RPC, recovery=${recoveryEnabled}`, async t => {
    let logoutCalls = 0
    const { service, manager } = fixture(async (): Promise<void> => { logoutCalls++ }, undefined, recoveryEnabled)
    const login = response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
    try {
      manager.emit('data', login)
      await flushStream(service, manager)
      service.once('logout', (): void => { manager.emit('data', login) })
      await assert.rejects(bounded(service.logout('older request')), /Superseded logout request/)
      await flushStream(service, manager)
      assert.equal(logoutCalls, 0)
      assert.equal(service.currentUserId, 'A')
      t.pass('ownership is checked again before submitting the RPC')
    } finally { await bounded(service.cleanup()); sinon.restore() }
  })

  for (const source of [ 'server', 'switch' ] as const) {
    test(`delayed ${source} logout listener cannot log out a newer account, recovery=${recoveryEnabled}`, async t => {
      await assertStaleLogoutListener(recoveryEnabled, source)
      t.pass('logout listeners cannot act for a new login')
    })
  }

  test(`a same-account LOGIN during cursor reset rolls back the partial write, recovery=${recoveryEnabled}`, async t => {
    await assertCursorRollback(recoveryEnabled)
    t.pass('a superseded reset does not overwrite the existing checkpoint')
  })
}

async function assertStaleLogoutListener (recoveryEnabled: boolean, source: 'server' | 'switch'): Promise<void> {
  let logoutCalls = 0
  const { service, manager } = fixture(async (): Promise<void> => { logoutCalls++ }, undefined, recoveryEnabled)
  const entered = deferred()
  const release = deferred()
  const rejected = deferred()
  service.once('logout', async ({ contactId }): Promise<void> => {
    assert.equal(contactId, 'A')
    entered.resolve()
    await release.promise
    await assert.rejects(service.logout('old listener'), /Superseded logout request/)
    rejected.resolve()
  })
  const loginB = response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' })
  try {
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
    await flushStream(service, manager)
    manager.emit('data', source === 'server' ? response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A' }) : loginB)
    await bounded(entered.promise)
    if (source === 'server') { manager.emit('data', loginB) }
    await flushStream(service, manager)
    release.resolve()
    await bounded(rejected.promise)
    assert.equal(logoutCalls, 0)
    assert.equal(service.currentUserId, 'B')
  } finally { release.resolve(); await bounded(service.cleanup()); sinon.restore() }
}

async function assertCursorRollback (recoveryEnabled: boolean): Promise<void> {
  let logoutCalls = 0
  const { service, manager } = fixture(async (): Promise<void> => { logoutCalls++ }, undefined, recoveryEnabled)
  const login = response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
  const store = service.store.miscellaneous!
  const remove = store.delete.bind(store)
  let interrupted = false
  try {
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }, 1))
    await flushStream(service, manager)
    assert.equal(await store.get('lastEventSeq'), '1')
    sinon.stub(store, 'delete').callsFake(async (key): ReturnType<typeof remove> => {
      const result = await remove(key)
      if (!interrupted && key === 'lastEventSeq') {
        interrupted = true
        manager.emit('data', login)
      }
      return result
    })
    manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'superseded' }, 2))
    await flushStream(service, manager)
    assert.equal(interrupted, true)
    assert.equal(await store.get('lastEventSeq'), '1')
    assert.equal(await store.get('accountId'), 'A')
    assert.equal(logoutCalls, 0)
    assert.equal(service.currentUserId, 'A')
  } finally { await bounded(service.cleanup()); sinon.restore() }
}

for (const contactId of [ 'A', 42 ]) {
  test(`replay counts a ${typeof contactId === 'string' ? 'mismatched' : 'malformed'} LOGOUT without persisting it`, async t => {
    const { service, manager } = fixture(undefined, undefined, true)
    const recovery = Reflect.get(service, 'recovery') as { begin: (accountId: string) => void }
    try {
      recovery.begin('B')
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' }, 1))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_READY, {}))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId }, 2))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'B', throughSeq: 2 }))
      await flushStream(service, manager)
      assert.equal(service.recoveryState.status, 'ready')
      assert.equal(service.currentUserId, 'B')
      assert.equal(await service.store.miscellaneous!.get('lastEventSeq'), '1')
      t.pass('an ignored notification cannot strand the active account in replay')
    } finally { await bounded(service.cleanup()); sinon.restore() }
  })
}

for (const target of [ 'A', 'B' ]) {
  test(`A -> LOGOUT -> ${target} serializes real local transitions without a Logout RPC`, async t => {
    let logoutCalls = 0
    const { service, manager } = fixture(async (): Promise<void> => { logoutCalls++ })
    const events: string[] = []
    service.on('login', ({ contactId }): void => { events.push(`login:${contactId}`) })
    service.on('logout', (): void => { events.push(`logout:${service.currentUserId}`) })
    try {
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      await flushStream(service, manager)
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { data: 'remote logout' }))
      await flushStream(service, manager)
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: target }))
      await flushStream(service, manager)
      assert.deepEqual(events, [ 'login:A', 'logout:A', `login:${target}` ])
      assert.equal(service.currentUserId, target)
      await service.prepareForRestart({ deadline: Date.now() + 2000 })
      assert.equal(logoutCalls, 0)
      t.pass('ordered authentication drains without a remote Logout')
    } finally { await bounded(service.cleanup()); sinon.restore() }
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
      const loggedOut = deferred()
      service.once('logout', loggedOut.resolve)
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'kicked' }))
      await bounded(loggedOut.promise)
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
      const loggedOut = deferred()
      service.once('logout', loggedOut.resolve)
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'kicked' }))
      manager.emit('data', response(puppet.EventType.EVENT_TYPE_SCAN, { status: 2, qrcode: 'qr' }))
      await bounded(loggedOut.promise)
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

async function workEasyScanFixture (recoveryEnabled: boolean, tokenPrefix = 'puppet_workeasy_') {
  const server = new grpc.Server()
  let stream!: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>
  let remoteLogouts = 0
  server.addService(puppet.PuppetService, {
    event: (call: typeof stream): void => {
      stream = call
      call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}))
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => {
      stream.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      stream.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
      stream.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'A', throughSeq: 0 }))
      callback(null, new puppet.StartResponse())
    },
    logout: (_call: grpc.ServerUnaryCall<puppet.LogoutRequest, puppet.LogoutResponse>, callback: grpc.sendUnaryData<puppet.LogoutResponse>): void => {
      remoteLogouts++
      callback(null, new puppet.LogoutResponse())
    },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
  })
  const port = await bounded(new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  }))
  const service = new AuthService({ token: `${tokenPrefix}${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: recoveryEnabled } })
  // Keep the real transport, authentication queue and cursor store; payload-cache loading is unrelated.
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  const events: string[] = []
  const scanLoginStates: boolean[] = []
  const errors: unknown[] = []
  let lastDrainedAt = 0
  service.on('login', ({ contactId }): void => { events.push(`login:${contactId}`) })
  service.on('logout', ({ contactId }): void => { events.push(`logout:${contactId}`) })
  service.on('scan', (): void => { scanLoginStates.push(service.isLoggedIn); events.push('scan') })
  service.on('error', (error): void => { errors.push(error) })
  const send = (type: ReturnType<puppet.EventResponse['getType']>, payload: unknown): void => { stream.write(response(type, payload)) }
  const flush = async (): Promise<void> => {
    const received = deferred()
    service.once('dong', received.resolve)
    send(puppet.EventType.EVENT_TYPE_DONG, { data: 'scan test drained' })
    await bounded(received.promise)
    lastDrainedAt = Date.now()
  }
  const freshScan = async (): Promise<PUPPET.payloads.EventScan> => {
    // Wait for a newer millisecond instead of assuming the event loop advances Date.now().
    await until((): boolean => Date.now() > lastDrainedAt, 'new QR creation time')
    const now = Date.now()
    return {
      type: PUPPET.types.ScanType.Login,
      status: PUPPET.types.ScanStatus.Waiting,
      qrcode: 'synthetic-login-qr',
      timestamp: now,
      createTimestamp: now,
      expireTimestamp: now + 600_000,
    }
  }
  const verify = async (): Promise<void> => {
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.equal(remoteLogouts, 0, 'local cleanup must never send the remote Logout RPC')
    assert.deepEqual(errors, [], 'authentication events must not report stream errors')
  }
  const close = async (): Promise<void> => {
    try { await bounded(service.cleanup()) } finally { server.forceShutdown(); sinon.restore() }
  }
  try {
    await bounded(service.onStart())
    await flush()
    assert.equal(service.currentUserId, 'A')
    return { service, events, scanLoginStates, send, flush, freshScan, verify, close }
  } catch (error) {
    await close()
    throw error
  }
}

for (const recoveryEnabled of [ false, true ]) {
  test(`WorkEasy new login QR resets cached identity without LOGOUT, recovery=${recoveryEnabled}`, async t => {
    const f = await workEasyScanFixture(recoveryEnabled)
    try {
      f.send(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
      await f.flush()
      assert.deepEqual(f.events, [ 'login:A' ], 'ordinary duplicate LOGIN remains idempotent')
      const scan = await f.freshScan()
      f.send(puppet.EventType.EVENT_TYPE_SCAN, scan)
      await f.flush()
      assert.equal(f.service.isLoggedIn, false)
      assert.deepEqual(f.events, [ 'login:A', 'logout:A', 'scan' ], 'local logout precedes SCAN')
      assert.deepEqual(f.scanLoginStates, [ false ])
      f.send(puppet.EventType.EVENT_TYPE_SCAN, scan)
      await f.flush()
      assert.equal(f.events.filter(event => event === 'logout:A').length, 1, 'repeated QR does not repeat logout')
      f.send(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
      f.send(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
      f.send(puppet.EventType.EVENT_TYPE_READY, {})
      await f.flush()
      assert.equal(f.service.currentUserId, 'A')
      assert.equal(f.events.filter(event => event === 'login:A').length, 2, 'the new scan cycle emits one new login')
      if (recoveryEnabled) { assert.equal(f.service.recoveryState.status, 'ready') }
      await f.verify()
      t.pass('same-account relogin works without a server LOGOUT or a destructive RPC')
    } finally { await f.close() }
  })

  test(`WorkEasy adjacent SCAN and LOGIN preserve authentication order, recovery=${recoveryEnabled}`, async t => {
    const f = await workEasyScanFixture(recoveryEnabled)
    try {
      f.send(puppet.EventType.EVENT_TYPE_SCAN, await f.freshScan())
      f.send(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
      f.send(puppet.EventType.EVENT_TYPE_READY, {})
      await f.flush()
      assert.deepEqual(f.events, [ 'login:A', 'logout:A', 'scan', 'login:A' ])
      assert.deepEqual(f.scanLoginStates, [ false ])
      assert.equal(f.service.currentUserId, 'A')
      if (recoveryEnabled) { assert.equal(f.service.recoveryState.status, 'ready') }
      await f.verify()
      t.pass('a following same-account LOGIN cannot supersede the required local cleanup')
    } finally { await f.close() }
  })

  test(`WorkEasy old QR cannot log out a completed relogin, recovery=${recoveryEnabled}`, async t => {
    const f = await workEasyScanFixture(recoveryEnabled)
    try {
      const scan = await f.freshScan()
      f.send(puppet.EventType.EVENT_TYPE_SCAN, scan)
      await f.flush()
      f.send(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
      f.send(puppet.EventType.EVENT_TYPE_READY, {})
      await f.flush()
      const before = f.events.slice()
      f.send(puppet.EventType.EVENT_TYPE_SCAN, scan)
      await f.flush()
      assert.equal(f.service.currentUserId, 'A')
      assert.deepEqual(f.events, [ ...before, 'scan' ], 'the stale QR is forwarded without another logout')
      assert.deepEqual(f.scanLoginStates, [ false, true ])
      await f.verify()
      t.pass('a delayed QR cannot clear the newer local identity')
    } finally { await f.close() }
  })

  test(`WorkEasy old QR cannot fence a LOGIN already received, recovery=${recoveryEnabled}`, async t => {
    const f = await workEasyScanFixture(recoveryEnabled)
    try {
      const scan = await f.freshScan()
      await until((): boolean => Date.now() > scan.createTimestamp!, 'LOGIN newer than QR')
      f.send(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
      f.send(puppet.EventType.EVENT_TYPE_SCAN, scan)
      await f.flush()
      assert.equal(f.service.currentUserId, 'A')
      assert.deepEqual(f.events, [ 'login:A', 'scan' ])
      assert.deepEqual(f.scanLoginStates, [ true ])
      await f.verify()
      t.pass('a duplicate LOGIN confirms the live session before an older QR arrives')
    } finally { await f.close() }
  })

  test(`WorkEasy expired new QR preserves the logged-in session, recovery=${recoveryEnabled}`, async t => {
    const f = await workEasyScanFixture(recoveryEnabled)
    try {
      const scan = await f.freshScan()
      scan.expireTimestamp = scan.createTimestamp! + 1
      await until((): boolean => Date.now() > scan.expireTimestamp!, 'QR expiry')
      f.send(puppet.EventType.EVENT_TYPE_SCAN, scan)
      await f.flush()
      assert.equal(f.service.currentUserId, 'A')
      assert.deepEqual(f.events, [ 'login:A', 'scan' ])
      assert.deepEqual(f.scanLoginStates, [ true ])
      await f.verify()
      t.pass('expiry is checked even when QR creation is newer than the login')
    } finally { await f.close() }
  })

  test(`WorkEasy non-login or invalid QR preserves the local session, recovery=${recoveryEnabled}`, async t => {
    const f = await workEasyScanFixture(recoveryEnabled)
    try {
      const scan = await f.freshScan()
      const future = Date.now() + 600_000
      const variants: [string, Record<string, unknown>][] = [
        [ 'verification', { type: PUPPET.types.ScanType.Verify } ],
        [ 'idle', { status: PUPPET.types.ScanStatus.Idle } ],
        [ 'scanned', { status: PUPPET.types.ScanStatus.Scanned } ],
        [ 'confirmed', { status: PUPPET.types.ScanStatus.Confirmed } ],
        [ 'blank QR', { qrcode: ' ' } ],
        [ 'missing creation', { createTimestamp: undefined } ],
        [ 'missing expiry', { expireTimestamp: undefined } ],
        [ 'invalid creation', { createTimestamp: 'not a timestamp' } ],
        [ 'invalid expiry order', { expireTimestamp: scan.createTimestamp! - 1 } ],
        [ 'future creation', { createTimestamp: future, expireTimestamp: future + 600_000 } ],
      ]
      for (const [ label, change ] of variants) {
        f.send(puppet.EventType.EVENT_TYPE_SCAN, { ...scan, ...change })
        await f.flush()
        assert.equal(f.service.currentUserId, 'A', label)
        assert.equal(f.events.filter(event => event === 'logout:A').length, 0, label)
      }
      await f.verify()
      t.pass('verification, other scan states and invalid QR metadata do not end a session')
    } finally { await f.close() }
  })

  test(`non-WorkEasy login QR preserves existing behavior, recovery=${recoveryEnabled}`, async t => {
    const f = await workEasyScanFixture(recoveryEnabled, 'puppet_workhermit_')
    try {
      f.send(puppet.EventType.EVENT_TYPE_SCAN, await f.freshScan())
      await f.flush()
      assert.equal(f.service.currentUserId, 'A')
      assert.deepEqual(f.events, [ 'login:A', 'scan' ])
      assert.deepEqual(f.scanLoginStates, [ true ])
      await f.verify()
      t.pass('the new local logout is limited to WorkEasy')
    } finally { await f.close() }
  })
}
