import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { PuppetService } from './puppet-service.js'

class LogoutOwnerService extends PuppetService {

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

function login (contactId: string): puppet.EventResponse {
  return response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId })
}

async function until (condition: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${label}`) }
    await new Promise<void>((resolve): void => { setTimeout(resolve, 5) })
  }
}

/**
 * An account switch clears the current user locally before the new one is projected, and
 * `currentUserId` throws while no account is current: a poll must read the flag first.
 */
function signedInAs (service: LogoutOwnerService, contactId: string): boolean {
  return service.isLoggedIn && service.currentUserId === contactId
}

interface HarnessOptions {
  readonly recoveryEnabled: boolean
  /** Written on the new event stream right after the server sees Start. */
  readonly connect: (write: (event: puppet.EventResponse) => void) => void
  /** Replaces the default accepted Logout reply; the callback is answered by the hook. */
  readonly logout?: (callback: grpc.sendUnaryData<puppet.LogoutResponse>) => void
}

interface Harness {
  readonly service: LogoutOwnerService
  readonly write: (event: puppet.EventResponse) => void
  /** Delivers an event through the live manager's bridge, synchronously, as a socket read would. */
  readonly deliver: (event: puppet.EventResponse) => void
  readonly logoutCalls: () => number
  readonly close: () => Promise<void>
}

async function startHarness (options: HarnessOptions): Promise<Harness> {
  const server = new grpc.Server()
  let stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse> | undefined
  let logouts = 0
  const write = (event: puppet.EventResponse): void => {
    if (!stream) { throw new Error('the server has no event stream yet') }
    stream.write(event)
  }
  server.addService(puppet.PuppetService, {
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      stream = call
      call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}))
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => {
      options.connect(write)
      callback(null, new puppet.StartResponse())
    },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => {
      callback(null, new puppet.StopResponse())
    },
    logout: (_call: grpc.ServerUnaryCall<puppet.LogoutRequest, puppet.LogoutResponse>, callback: grpc.sendUnaryData<puppet.LogoutResponse>): void => {
      logouts++
      if (options.logout) { options.logout(callback); return }
      callback(null, new puppet.LogoutResponse())
    },
  })
  const port = await bounded(new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  }))
  const service = new LogoutOwnerService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: options.recoveryEnabled } })
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  service.on('error', (): void => {})
  return {
    service,
    write,
    deliver: (event): void => { service.grpcManager.emit('data', event) },
    logoutCalls: (): number => logouts,
    close: async (): Promise<void> => { server.forceShutdown(); await bounded(service.cleanup()) },
  }
}

/** A ready session: LOGIN, READY and the replay barrier a real Work stream sends on connect. */
function openSession (write: (event: puppet.EventResponse) => void, contactId = 'A'): void {
  write(login(contactId))
  write(response(puppet.EventType.EVENT_TYPE_READY, {}))
  write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: contactId, throughSeq: 0 }))
}

for (const recoveryEnabled of [ true, false ]) {
  test(`logout from a real LOGIN listener reaches the server once, recovery=${recoveryEnabled}`, async t => {
    const failures: unknown[] = []
    let listenerDone!: () => void
    const done = new Promise<void>((resolve): void => { listenerDone = resolve })
    const harness = await startHarness({ recoveryEnabled, connect: write => openSession(write) })
    let loggedOut = false
    harness.service.on('login', async ({ contactId }): Promise<void> => {
      if (contactId !== 'A' || loggedOut) { return }
      loggedOut = true
      // The listener awaits before logging out: the SDK must still own the Logout RPC it derives.
      await new Promise<void>((resolve): void => { setImmediate(resolve) })
      try { await harness.service.logout('wrong account') } catch (error) { failures.push(error) } finally { listenerDone() }
    })
    try {
      await bounded(harness.service.onStart())
      await bounded(done)
      assert.deepEqual(
        { failures: failures.map(String), logoutCalls: harness.logoutCalls() },
        { failures: [], logoutCalls: 1 },
        'the listener logout must reach the server exactly once',
      )
      assert.equal(harness.service.isLoggedIn, false)
      const settled = new Promise<void>((resolve): void => { harness.service.once('dong', (): void => { resolve() }) })
      harness.write(response(puppet.EventType.EVENT_TYPE_DONG, { data: 'after logout' }))
      await bounded(settled)
      assert.equal(harness.logoutCalls(), 1, 'a submitted Logout is never retried')
      t.pass('a logout taken from the LOGIN session it ends is submitted under its own fence')
    } finally { await harness.close(); sinon.restore() }
  })
}

test('a LOGIN listener superseded by another account never logs out the new account', async t => {
  const failures: unknown[] = []
  let staleEntered!: () => void
  const entered = new Promise<void>((resolve): void => { staleEntered = resolve })
  let releaseStale!: () => void
  const holdStale = new Promise<void>((resolve): void => { releaseStale = resolve })
  const harness = await startHarness({ recoveryEnabled: true, connect: write => openSession(write) })
  harness.service.on('login', async ({ contactId }): Promise<void> => {
    if (contactId !== 'A') { return }
    staleEntered()
    await holdStale
    try { await harness.service.logout('stale wrong account') } catch (error) { failures.push(error) }
  })
  try {
    await bounded(harness.service.onStart())
    await bounded(entered)
    harness.write(login('B'))
    await bounded(until((): boolean => signedInAs(harness.service, 'B'), 'login B'))
    releaseStale()
    await bounded(until((): boolean => failures.length === 1, 'stale logout rejection'))
    assert.match(String(failures[0]), /Superseded logout request/)
    assert.equal(harness.logoutCalls(), 0, 'a superseded listener never logs the server out')
    assert.equal(harness.service.currentUserId, 'B')
    assert.equal(harness.service.isLoggedIn, true)
    t.pass('the account that arrived later keeps its local state and its session')
  } finally { releaseStale(); await harness.close(); sinon.restore() }
})

test('waiting for a switch tolerates the window in which no account is current', async t => {
  const harness = await startHarness({ recoveryEnabled: true, connect: write => openSession(write) })
  const store = harness.service.store.miscellaneous!
  const original = store.set.bind(store)
  let projected!: () => void
  const projecting = new Promise<void>((resolve): void => { projected = resolve })
  let release!: () => void
  const blocked = new Promise<void>((resolve): void => { release = resolve })
  // The account write is the last async step before B is projected: holding it makes the window
  // in which A's local logout has already cleared the current user deterministic.
  sinon.stub(store, 'set').callsFake(async (key, value): ReturnType<typeof original> => {
    if (key === 'accountId' && value === 'B') { projected(); await blocked }
    return original(key, value)
  })
  try {
    await bounded(harness.service.onStart())
    await bounded(until((): boolean => signedInAs(harness.service, 'A'), 'login A'))
    harness.write(login('B'))
    await bounded(projecting)
    assert.equal(harness.service.isLoggedIn, false, 'the switch clears the previous account first')
    assert.equal(signedInAs(harness.service, 'B'), false, 'the poll must not throw while nobody is current')
    release()
    await bounded(until((): boolean => signedInAs(harness.service, 'B'), 'login B'))
    assert.equal(harness.service.isLoggedIn, true)
    t.pass('only the projected account satisfies the wait')
  } finally { release(); await harness.close(); sinon.restore() }
})

for (const account of [ 'A', 'B' ]) {
  test(`a ${account === 'A' ? 'repeated' : 'different'} LOGIN inside the logout window cancels the unsubmitted Logout`, async t => {
    const harness = await startHarness({ recoveryEnabled: true, connect: write => openSession(write) })
    let injected = false
    harness.service.on('logout', (): void => {
      if (injected) { return }
      injected = true
      // This listener runs after the logout's own session fence and before its RPC is submitted.
      // Deliver the next LOGIN through the live bridge inside that window.
      harness.deliver(login(account))
    })
    try {
      await bounded(harness.service.onStart())
      await bounded(until((): boolean => harness.service.isLoggedIn, 'login A'))
      // The local session already ended here, but the Logout RPC was never submitted: the caller
      // must not be told it was. This is the pre-check, not the interceptor's own rejection.
      await assert.rejects(bounded(harness.service.logout('wrong account')), /Superseded logout request/)
      await bounded(until((): boolean => harness.service.isLoggedIn, 'the arriving LOGIN'))
      assert.equal(harness.logoutCalls(), 0, 'an unsubmitted Logout must not follow the new LOGIN')
      assert.equal(harness.service.currentUserId, account)
      assert.equal(harness.service.isLoggedIn, true, 'the arriving account is not cleared')
      await assert.rejects(harness.service.prepareForRestart({ deadline: Date.now() + 2000 }), /Superseded logout request/)
      t.pass(`a LOGIN for ${account} takes the account back and the unsubmitted Logout stays visible`)
    } finally { await harness.close(); sinon.restore() }
  })
}

test('a transport replaced inside the logout window keeps the old Logout off both managers', async t => {
  const harness = await startHarness({ recoveryEnabled: true, connect: write => openSession(write) })
  let stopping: Promise<void> | undefined
  let injected = false
  harness.service.on('logout', (): void => {
    if (injected) { return }
    injected = true
    stopping = harness.service.onStop().catch((): void => {})
  })
  try {
    await bounded(harness.service.onStart())
    await bounded(until((): boolean => harness.service.isLoggedIn, 'login A'))
    await assert.rejects(bounded(harness.service.logout('wrong account')), /Superseded logout request/)
    await bounded(stopping ?? Promise.resolve())
    assert.equal(harness.logoutCalls(), 0, 'a retired transport never receives the old Logout')
    const next = new Promise<void>((resolve): void => { harness.service.once('login', (): void => { resolve() }) })
    await bounded(harness.service.onStart())
    harness.write(login('A'))
    harness.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
    harness.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'A', throughSeq: 0 }))
    await bounded(next)
    assert.equal(harness.logoutCalls(), 0, 'the new manager never inherits the old Logout either')
    t.pass('transport replacement supersedes the pending logout instead of re-targeting it')
  } finally { await harness.close(); sinon.restore() }
})

test('a cancelled or expired request context never submits the Logout', async t => {
  const harness = await startHarness({ recoveryEnabled: true, connect: write => openSession(write) })
  try {
    await bounded(harness.service.onStart())
    await bounded(until((): boolean => harness.service.isLoggedIn, 'login A'))
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(
      bounded(harness.service.withRecoveryRequestContext({ signal: abort.signal }, async (): Promise<void> => harness.service.logout('cancelled'))),
      /cancelled/i,
    )
    await assert.rejects(
      bounded(harness.service.withRecoveryRequestContext({ deadline: Date.now() - 1 }, async (): Promise<void> => harness.service.logout('expired'))),
      /deadline|expired|cancelled/i,
    )
    assert.equal(harness.logoutCalls(), 0, 'the caller cancellation still owns the unsubmitted call')
    t.pass('the caller request context is not dropped by the owned logout')
  } finally { await harness.close(); sinon.restore() }
})

test('a logout without an event context still submits during suspended recovery', async t => {
  const harness = await startHarness({ recoveryEnabled: true, connect: write => write(login('A')) })
  try {
    await bounded(harness.service.onStart())
    await bounded(until((): boolean => harness.service.isLoggedIn, 'login A'))
    assert.equal(harness.service.recoveryState.status, 'recovering')
    await bounded(harness.service.logout('http style logout'))
    assert.equal(harness.logoutCalls(), 1)
    assert.equal(harness.service.isLoggedIn, false)
    t.pass('an external logout is still generation-bound, not stream-bound')
  } finally { await harness.close(); sinon.restore() }
})

test('a hanging owned Logout blocks restart preparation and a rejected one stays drained', async t => {
  let answer!: grpc.sendUnaryData<puppet.LogoutResponse>
  let accepted!: () => void
  const acceptance = new Promise<void>((resolve): void => { accepted = resolve })
  const harness = await startHarness({
    recoveryEnabled: true,
    connect: write => openSession(write),
    logout: (callback): void => { answer = callback; accepted() },
  })
  try {
    await bounded(harness.service.onStart())
    await bounded(until((): boolean => harness.service.isLoggedIn, 'login A'))
    const logout = harness.service.logout('user logout')
    const timedOut = logout.catch((error: unknown): Error => error instanceof Error ? error : new Error(String(error)))
    await bounded(acceptance)
    assert.equal(harness.logoutCalls(), 1)
    harness.write(login('A'))
    harness.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
    harness.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'A', throughSeq: 0 }))
    await bounded(until((): boolean => harness.service.recoveryState.status === 'ready', 'live session'))
    await assert.rejects(harness.service.prepareForRestart({ deadline: Date.now() + 50 }), /deadline/)
    answer({ code: grpc.status.UNAVAILABLE, details: 'logout rejected late' })
    assert.match(String(await bounded(timedOut)), /logout rejected late/)
    await assert.rejects(harness.service.prepareForRestart({ deadline: Date.now() + 2000 }), /logout rejected late/)
    assert.equal(harness.logoutCalls(), 1)
    t.pass('the owned Logout stays inside the SDK drain for both completion and failure')
  } finally { await harness.close(); sinon.restore() }
})
