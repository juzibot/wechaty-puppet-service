import assert from 'node:assert/strict'
import util from 'node:util'
import { getEventListeners } from 'node:events'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { RecoveryGate, withRecoveryRequestContext } from './recovery.js'
import { PuppetService } from './puppet-service.js'
import { GrpcManager } from './grpc-manager.js'

class RecoveryTestService extends PuppetService {

  readonly loginAccounts: string[] = []
  protected override hookPayloadStore (): void {}
  override async login (contactId: string): Promise<void> { this.loginAccounts.push(contactId) }
  get eventMetadataStore (): { get(key: string): Promise<string | undefined> } | undefined { return this._payloadStore.miscellaneous }
  async destroyTestStore (): Promise<void> { await this._payloadStore.destroy() }

}

async function until (condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error('Condition timed out') }
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

function response (type: ReturnType<puppet.EventResponse['getType']>, payload: unknown, seq = 0): puppet.EventResponse {
  const event = new puppet.EventResponse()
  event.setType(type); event.setPayload(JSON.stringify(payload)); event.setSeq(seq)
  return event
}

test('gate requires login, ready and processed barrier; cancellation prevents deferred sends', async t => {
  const gate = new RecoveryGate({ enabled: true })
  gate.begin('account')
  gate.login('account')
  gate.ready()
  const abort = new AbortController()
  const waiting = withRecoveryRequestContext({ signal: abort.signal }, async (): Promise<void> => gate.wait())
  abort.abort()
  await assert.rejects(waiting)
  assert.equal(gate.state.status, 'recovering')
  gate.barrier('account')
  await gate.wait()
  assert.equal(gate.state.status, 'ready')
  t.pass('gate opens only after the barrier and cancelled requests reject')
})

test('budget does not refresh across connections and old servers never unlock', async t => {
  const gate = new RecoveryGate({ enabled: true, maxRecoveryMilliseconds: 1000 })
  gate.begin('account')
  const originalState = gate.state
  assert.equal(originalState.status, 'recovering')
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  gate.begin('account')
  gate.login('account')
  gate.ready()
  assert.deepEqual(gate.state, originalState)
  const pending = gate.wait()
  const rejected = assert.rejects(pending, /budget/)
  await rejected
  assert.equal(gate.state.status, 'offline')
  t.pass('reconnection preserves the original finite deadline and missing barrier expires')
})

test('an early deadline timer wakeup cannot strand a pending request', async t => {
  const gate = new RecoveryGate({ enabled: true, maxRecoveryMilliseconds: 1000 })
  gate.begin('account')
  const now = sinon.stub(Date, 'now').returns(1000)
  let timeout: NodeJS.Timeout | undefined
  try {
    const pending = assert.rejects(gate.wait({ deadline: 1010 }), /deadline/)
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    now.returns(1020)
    await Promise.race([
      pending,
      new Promise<never>((_resolve, reject): void => { timeout = setTimeout((): void => { reject(new Error('Early timer lost the absolute deadline')) }, 100) }),
    ])
    t.pass('early wakeup rearms the absolute deadline')
  } finally { clearTimeout(timeout); now.restore(); gate.fail('Request deadline cleanup') }
})

test('real grpc send boundary: controls/reads, cancellation, deadlines, and no write retries', async t => {
  const server = new grpc.Server()
  let sends = 0
  server.addService(puppet.PuppetService, {
    ding: (_call: grpc.ServerUnaryCall<puppet.DingRequest, puppet.DingResponse>, callback: grpc.sendUnaryData<puppet.DingResponse>): void => { callback(null, new puppet.DingResponse()) },
    contactPayload: (_call: grpc.ServerUnaryCall<puppet.ContactPayloadRequest, puppet.ContactPayloadResponse>, callback: grpc.sendUnaryData<puppet.ContactPayloadResponse>): void => { callback(null, new puppet.ContactPayloadResponse()) },
    messageSendText: (_call: grpc.ServerUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>, callback: grpc.sendUnaryData<puppet.MessageSendTextResponse>): void => {
      sends++
      callback({ code: grpc.status.UNAVAILABLE, details: 'accepted but response lost' })
    },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const gate = new RecoveryGate({ enabled: true })
  const client = new puppet.PuppetClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), {
    interceptors: [ gate.interceptor ], 'grpc.enable_retries': 0,
  })
  const send = async (): Promise<puppet.MessageSendTextResponse> => util.promisify(client.messageSendText.bind(client))(new puppet.MessageSendTextRequest())
  try {
    gate.begin('account')
    await util.promisify(client.ding.bind(client))(new puppet.DingRequest())
    await gate.runEvent((): boolean => true, async (): Promise<puppet.ContactPayloadResponse> => util.promisify(client.contactPayload.bind(client))(new puppet.ContactPayloadRequest()))
    const controller = new AbortController()
    const cancelled = withRecoveryRequestContext({ signal: controller.signal }, send)
    controller.abort()
    await assert.rejects(cancelled, /CANCELLED/)
    await assert.rejects(withRecoveryRequestContext({ deadline: Date.now() + 20 }, send), /DEADLINE_EXCEEDED/)
    const directlyCancelled = new Promise<puppet.MessageSendTextResponse>((resolve, reject): void => {
      const call = client.messageSendText(new puppet.MessageSendTextRequest(), (error, result): void => { error ? reject(error) : resolve(result) })
      call.cancel()
    })
    await assert.rejects(directlyCancelled, /CANCELLED/)
    await assert.rejects(withRecoveryRequestContext({ deadline: Date.now() + 20 }, async (): Promise<puppet.ContactPayloadResponse> => util.promisify(client.contactPayload.bind(client))(new puppet.ContactPayloadRequest())), /DEADLINE_EXCEEDED/)
    assert.equal(sends, 0)
    const pending = send()
    const rejected = assert.rejects(pending, /UNAVAILABLE/)
    gate.login('account')
    gate.ready()
    assert.equal(sends, 0)
    gate.barrier('account')
    await rejected
    assert.equal(sends, 1)
    gate.begin('account')
    const stale = gate.runEvent((): boolean => false, send)
    const staleRejected = assert.rejects(stale, /Superseded/)
    gate.login('account'); gate.ready(); gate.barrier('account')
    await staleRejected
    assert.equal(sends, 1)
    gate.begin('account')
    const changed = send()
    const changedRejected = assert.rejects(changed, /Account changed/)
    gate.login('different-account')
    await changedRejected
    assert.equal(sends, 1)
  } finally {
    gate.fail('test complete')
    client.close()
    server.forceShutdown()
  }
  t.pass('real grpc enforces cancellation, deadlines and one-shot writes')
})

test('PuppetService waits for serial cache work before barrier and fences the previous stream', async t => {
  const server = new grpc.Server()
  const streams: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>[] = []
  let sends = 0
  server.addService(puppet.PuppetService, {
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      assert.equal(call.request.getReplayBarrier(), true)
      streams.push(call)
      call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, { data: 'connected' }))
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { callback(null, new puppet.StartResponse()) },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
    messageSendText: (_call: grpc.ServerUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>, callback: grpc.sendUnaryData<puppet.MessageSendTextResponse>): void => {
      sends++
      const result = new puppet.MessageSendTextResponse(); result.setId('sent')
      callback(null, result)
    },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const service = new RecoveryTestService({ token: 'insecure_recovery-test', endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: true, inactivityMilliseconds: 200 } })
  let release: () => void = (): void => {}
  const deletion = new Promise<void>(resolve => { release = resolve })
  const metadata = new Map<string, string>([ [ 'accountId', 'account' ] ])
  Object.defineProperty(service, '_payloadStore', {
    value: {
      room: { delete: async (): Promise<void> => deletion },
      roomMember: { delete: async (): Promise<void> => {} },
      miscellaneous: {
        get: async (key: string): Promise<string | undefined> => metadata.get(key),
        set: async (key: string, value: string): Promise<void> => { metadata.set(key, value) },
        delete: async (key: string): Promise<void> => { metadata.delete(key) },
      },
    },
  })
  service.on('error', (): void => {})
  try {
    await service.onStart()
    const previousStream = service.grpcManager.eventStream!
    const pending = service.messageSendText('contact', 'message')
    const first = streams[0]!
    first.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }))
    first.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
    first.write(response(puppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD, { roomId: 'room' }, 1))
    first.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'account', throughSeq: 1 }))
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    assert.equal(service.recoveryState.status, 'recovering')
    assert.equal(sends, 0)
    release()
    assert.equal(await pending, 'sent')
    assert.equal(metadata.get('lastEventSeq'), '1')
    first.end()
    await until((): boolean => service.recoveryState.status === 'recovering')
    await until((): boolean => streams.length === 2)
    const second = streams[1]!
    previousStream.emit('data', response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'account', throughSeq: 1 }))
    assert.equal(service.recoveryState.status, 'recovering')
    assert.equal(second.request.getSeq(), 1)
    second.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }))
    second.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    assert.equal(service.recoveryState.status, 'recovering')
    const cancelled = new AbortController()
    const blocked = service.withRecoveryRequestContext({ signal: cancelled.signal }, async (): Promise<string | void> => service.messageSendText('contact', 'late'))
    cancelled.abort()
    await assert.rejects(blocked)
    second.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'account', throughSeq: 1 }))
    await until((): boolean => service.recoveryState.status === 'ready')
    assert.equal(sends, 1)
    await until((): boolean => service.recoveryState.status === 'recovering')
    await until((): boolean => streams.length === 3)
    assert.equal(streams[2]!.request.getSeq(), 1)
    const terminal = service.messageSendText('contact', 'logged-out')
    const rejected = assert.rejects(terminal, /logged out/)
    streams[2]!.write(response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'account', data: 'logged out' }))
    await rejected
    assert.equal(service.recoveryState.status, 'offline')
    assert.equal(sends, 1)
  } finally {
    release()
    await service.onStop()
    server.forceShutdown()
  }
  t.pass('serial cache work, replay cursor, stream fencing and logout preserve the gate')
})

test('explicit stream failure never advances to start RPC in either mode', async t => {
  const server = new grpc.Server()
  let starts = 0
  server.addService(puppet.PuppetService, {
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => { call.end() },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { starts++; callback(null, new puppet.StartResponse()) },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  try {
    for (const enabled of [ false, true ]) {
      const gate = new RecoveryGate({ enabled })
      const manager = new GrpcManager({ token: 'insecure_failed-test', endpoint: `127.0.0.1:${port}`, tls: { disable: true } }, gate)
      manager.on('error', (): void => {})
      try { await assert.rejects(manager.start(), /stream ended/) } finally { await manager.stop() }
    }
    assert.equal(starts, 0)
  } finally { server.forceShutdown() }
  t.pass('failed streams never advance to start')
})

test('nested cancellation is Node16-compatible and releases parent/child listeners', async t => {
  const gate = new RecoveryGate({ enabled: true })
  gate.begin('account')
  try {
    for (const mode of [ 'parent', 'child', 'duplicate', 'already-aborted', 'already-aborted-child' ]) {
      const parent = new AbortController()
      const child = mode === 'duplicate' ? parent : new AbortController()
      if (mode === 'already-aborted') { parent.abort() }
      if (mode === 'already-aborted-child') { child.abort() }
      const pending = withRecoveryRequestContext({ signal: parent.signal }, (): Promise<void> =>
        withRecoveryRequestContext({ signal: child.signal }, async (): Promise<void> => gate.wait()))
      const rejected = assert.rejects(pending, /cancelled/)
      if (!mode.startsWith('already-aborted')) {
        assert.equal(getEventListeners(parent.signal, 'abort').length, 1)
        assert.equal(getEventListeners(child.signal, 'abort').length, 1)
        ;(mode === 'child' ? child : parent).abort()
      }
      await rejected
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
      assert.equal(getEventListeners(child.signal, 'abort').length, 0)
    }
    const parent = new AbortController()
    const child = new AbortController()
    const successful = withRecoveryRequestContext({ signal: parent.signal }, (): Promise<void> =>
      withRecoveryRequestContext({ signal: child.signal }, async (): Promise<void> => gate.wait()))
    gate.login('account'); gate.ready(); gate.barrier('account')
    await successful
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
    assert.equal(getEventListeners(child.signal, 'abort').length, 0)
  } finally { gate.fail('test complete') }
  t.pass('all nested signal combinations release their listeners')
})

test('ready session rejects account changes and cannot be reopened by late ready/barrier', async t => {
  const gate = new RecoveryGate({ enabled: true })
  gate.begin('A'); gate.login('A'); gate.ready(); gate.barrier('A')
  assert.equal(gate.state.status, 'ready')
  gate.login('B')
  gate.ready(); gate.barrier('A')
  assert.equal(gate.state.status, 'offline')
  await assert.rejects(gate.wait(), /Account changed/)
  t.pass('account changes remain terminal after ready')
})

test('pending requests have count/serialized-byte bounds and release on every terminal path', async t => {
  const gate = new RecoveryGate({ enabled: true, maxPendingRequests: 2, maxPendingBytes: 128 })
  const client = new puppet.PuppetClient('127.0.0.1:1', grpc.credentials.createInsecure(), { interceptors: [ gate.interceptor ] })
  const send = async (text: string): Promise<puppet.MessageSendTextResponse> => {
    const request = new puppet.MessageSendTextRequest(); request.setText(text)
    return util.promisify(client.messageSendText.bind(client))(request)
  }
  try {
    gate.begin('account')
    await assert.rejects(send('x'.repeat(1024)), { code: grpc.status.RESOURCE_EXHAUSTED })
    t.pass('oversized payload is rejected')
    const controller = new AbortController()
    const one = withRecoveryRequestContext({ signal: controller.signal }, async (): Promise<puppet.MessageSendTextResponse> => send('x'.repeat(80)))
    const oneRejected = assert.rejects(one, { code: grpc.status.CANCELLED })
    await assert.rejects(send('x'.repeat(80)), { code: grpc.status.RESOURCE_EXHAUSTED })
    controller.abort(); await oneRejected
    t.pass('cancelled byte reservation is released')
    for (let index = 0; index < 3; index++) {
      const controller = new AbortController()
      const first = withRecoveryRequestContext({ signal: controller.signal }, async (): Promise<puppet.MessageSendTextResponse> => send('one'))
      const second = withRecoveryRequestContext({ signal: controller.signal }, async (): Promise<puppet.MessageSendTextResponse> => send('two'))
      const rejected = Promise.all([ assert.rejects(first), assert.rejects(second) ])
      await Promise.all(Array.from({ length: 100 }, async (): Promise<void> => { await assert.rejects(send('overflow'), { code: grpc.status.RESOURCE_EXHAUSTED }) }))
      controller.abort(); await rejected
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      t.pass(`request saturation round ${index} releases all slots`)
    }
    await assert.rejects(withRecoveryRequestContext({ deadline: Date.now() + 10 }, async (): Promise<puppet.MessageSendTextResponse> => send('x'.repeat(80))), { code: grpc.status.DEADLINE_EXCEEDED })
    t.pass('first deadline releases its byte reservation')
    const waiting = send('x'.repeat(80))
    const rejected = assert.rejects(waiting, /terminal/)
    gate.fail('terminal'); await rejected
    t.pass('terminal state releases its byte reservation')
    gate.begin('account')
    await assert.rejects(withRecoveryRequestContext({ deadline: Date.now() + 10 }, async (): Promise<puppet.MessageSendTextResponse> => send('x'.repeat(80))), { code: grpc.status.DEADLINE_EXCEEDED })
  } finally { gate.fail('test complete'); client.close() }
  t.pass('request and byte limits reject overload and release capacity')
})

test('healthy heartbeat cannot keep unanswered lifecycle controls alive', async t => {
  const server = new grpc.Server()
  let started = 0
  let stopped = 0
  let cancelled = 0
  server.addService(puppet.PuppetService, {
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      const heartbeat = (): void => { call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {})) }
      heartbeat()
      const timer = setInterval(heartbeat, 5)
      call.on('cancelled', (): void => { clearInterval(timer) })
    },
    start: (call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>): void => { started++; call.on('cancelled', (): void => { cancelled++ }) },
    stop: (call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>): void => { stopped++; call.on('cancelled', (): void => { cancelled++ }) },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const service = new RecoveryTestService({ token: 'insecure_controls', endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: true, controlTimeoutMilliseconds: 40 } })
  service.on('error', (): void => {})
  try {
    const starting = assert.rejects(service.onStart(), /DEADLINE_EXCEEDED/)
    const manager = service.grpcManager
    await starting
    assert.equal(started, 1)
    await service.onStop()
    assert.equal(stopped, 0, 'failed initial startup closes locally without another remote control')
    assert.throws((): void => { void manager.client }, /NO CLIENT/)
    for (const mode of [ 'epoch', 'session', 'budget' ]) {
      const gate = new RecoveryGate({ enabled: true, maxRecoveryMilliseconds: 100, controlTimeoutMilliseconds: 1000 })
      const manager = new GrpcManager({ token: 'insecure_control-cancel', endpoint: `127.0.0.1:${port}`, tls: { disable: true } }, gate)
      manager.on('error', (): void => {})
      gate.begin('account')
      const count = started
      const pending = manager.start()
      const rejected = assert.rejects(pending, /CANCELLED/)
      await until((): boolean => started > count)
      if (mode === 'epoch') { gate.replaceControls() }
      if (mode === 'session') { gate.begin('account', true) }
      await rejected
      gate.fail('test complete')
      const stopCount = stopped
      const stop = manager.stop()
      await until((): boolean => stopped > stopCount)
      gate.replaceControls()
      await stop
    }
    const concurrent = new RecoveryTestService({ token: 'insecure_concurrent-stop', endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: true, controlTimeoutMilliseconds: 1000 } })
    concurrent.on('error', (): void => {})
    const startCount = started
    const concurrentStarting = assert.rejects(concurrent.onStart(), /interrupted by stop/)
    await until((): boolean => started > startCount)
    const stoppingAt = Date.now()
    const stopping = concurrent.withRecoveryRequestContext({ deadline: Date.now() + 40 }, async (): Promise<void> => concurrent.onStop())
    await concurrentStarting
    assert.ok(Date.now() - stoppingAt < 500, 'stop cancels old Start instead of waiting its 1000ms deadline')
    await stopping
    await until((): boolean => cancelled >= 9)
  } finally { server.forceShutdown() }
  t.pass('control deadlines and lifecycle cancellation bound start and stop')
})

test('PuppetService isolates LOGIN B after ready A even when already logged in', async t => {
  const server = new grpc.Server()
  let stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse> | undefined
  let sends = 0
  server.addService(puppet.PuppetService, {
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      stream = call
      call.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      call.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
      call.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'A', throughSeq: 0 }))
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { callback(null, new puppet.StartResponse()) },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
    messageSendText: (_call: grpc.ServerUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>, callback: grpc.sendUnaryData<puppet.MessageSendTextResponse>): void => { sends++; callback(null, new puppet.MessageSendTextResponse()) },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const service = new RecoveryTestService({ token: 'insecure_swapped-account', endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: true } })
  Object.defineProperty(service, 'isLoggedIn', { get: (): boolean => true })
  service.on('error', (): void => {})
  try {
    await service.onStart()
    await until((): boolean => service.recoveryState.status === 'ready')
    await service.messageSendText('contact', 'before')
    assert.equal(sends, 1)
    stream!.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'B' }))
    await until((): boolean => service.recoveryState.status === 'offline')
    await assert.rejects(service.messageSendText('contact', 'after'), /Account changed/)
    assert.equal(sends, 1)
    assert.equal(service.grpcManager.eventStream, undefined)
  } finally { await service.onStop(); server.forceShutdown() }
  t.pass('the SDK rejects writes after a ready-session account change')
})

test('event-triggered Stop detaches stale contexts and reports server failure', async t => {
  for (const failStop of [ false, true ]) {
    const server = new grpc.Server()
    let stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse> | undefined
    let stopCalls = 0
    server.addService(puppet.PuppetService, {
      event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
        stream = call
        call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}))
      },
      start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { callback(null, new puppet.StartResponse()) },
      stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => {
        stopCalls++
        if (failStop) { callback({ code: grpc.status.UNAVAILABLE, details: 'observable stop failure' }); return }
        callback(null, new puppet.StopResponse())
      },
    })
    const port = await new Promise<number>((resolve, reject): void => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
    })
    const service = new RecoveryTestService({ token: `insecure_event-stop-${failStop}-${process.pid}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: true, controlTimeoutMilliseconds: 1000 } })
    const errors: unknown[] = []
    service.on('error', (error: unknown): void => { errors.push(error) })
    let stopping: Promise<void> | undefined
    service.on('dong', (): void => {
      const controller = new AbortController(); controller.abort()
      stopping = service.withRecoveryRequestContext({ signal: controller.signal, deadline: Date.now() - 1 }, async (): Promise<void> => service.onStop())
    })
    try {
      await service.onStart()
      stream!.write(response(puppet.EventType.EVENT_TYPE_DONG, { data: 'stop' }))
      await until((): boolean => stopping !== undefined)
      await stopping
      t.equal(stopCalls, 1, 'Stop reaches the real TCP server despite the stale event and cancelled request contexts')
      t.equal(errors.length, failStop ? 1 : 0, 'server Stop failure is observable, successful Stop is quiet')
      if (failStop) { t.match(JSON.stringify(errors[0]), /observable stop failure/, 'the original server error reaches the observer') }
      t.equal(service.recoveryState.status, 'offline', 'Stop failure cannot restart recovery')
    } finally { if (!stopping) { await service.onStop() }; server.forceShutdown() }
  }
})

test('suspended LOGIN persistence cannot log in after budget expiry, stop or epoch replacement', async t => {
  for (const mode of [ 'budget', 'stop', 'replace' ]) {
    const server = new grpc.Server()
    let stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse> | undefined
    server.addService(puppet.PuppetService, {
      event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => { stream = call; call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {})) },
      start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { callback(null, new puppet.StartResponse()) },
      stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
    })
    const port = await new Promise<number>((resolve, reject): void => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
    })
    const service = new RecoveryTestService({ token: `insecure_late-login-${mode}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: true, maxRecoveryMilliseconds: 1000 } })
    const metadata = new Map<string, string>()
    let release: () => void = (): void => {}
    let entered = false
    const deletion = new Promise<void>(resolve => { release = resolve })
    Object.defineProperty(service, '_payloadStore', {
      value: {
        miscellaneous: {
          get: async (key: string): Promise<string | undefined> => metadata.get(key),
          set: async (key: string, value: string): Promise<void> => { metadata.set(key, value) },
          delete: async (key: string): Promise<void> => {
            if (!entered) { entered = true; await deletion }
            metadata.delete(key)
          },
        },
      },
    })
    service.on('error', (): void => {})
    let stopping: Promise<void> | undefined
    try {
      await service.onStart()
      stream!.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'late-account' }))
      await until((): boolean => entered)
      if (mode === 'budget') { await until((): boolean => service.recoveryState.status === 'offline') }
      if (mode === 'stop') { stopping = service.onStop() }
      if (mode === 'replace') { await service.reset() }
      release()
      await new Promise<void>(resolve => setImmediate(resolve))
      t.same(service.loginAccounts, [], `${mode}: no login before cleanup`)
      if (stopping) { await stopping } else { await service.onStop() }
      await new Promise<void>(resolve => setImmediate(resolve))
      t.same(service.loginAccounts, [], `${mode}: no late login side effect`)
      t.equal(metadata.get('accountId'), undefined, `${mode}: no account identity persisted`)
    } finally { release(); if (!stopping) { await service.onStop() }; server.forceShutdown() }
  }
})

test('recovery cursor persists with event cache disabled while legacy clients keep caching disabled', async t => {
  const previous = process.env['WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE']
  process.env['WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE'] = 'true'
  try {
    for (const enabled of [ true, false ]) {
      const server = new grpc.Server()
      const streams: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>[] = []
      server.addService(puppet.PuppetService, {
        event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
          streams.push(call)
          call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}))
        },
        start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { callback(null, new puppet.StartResponse()) },
        stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
      })
      const port = await new Promise<number>((resolve, reject): void => {
        server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
      })
      const service = new RecoveryTestService({ token: `insecure_cache-disabled-${enabled}-${process.pid}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled } })
      const errors: unknown[] = []
      service.on('error', (error: unknown): void => { errors.push(error) })
      let messages = 0
      service.on('message', (): void => { messages++ })
      try {
        await service.onStart()
        assert.equal(streams[0]!.request.getReplayBarrier(), enabled)
        streams[0]!.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }))
        streams[0]!.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
        streams[0]!.write(response(puppet.EventType.EVENT_TYPE_MESSAGE, { messageId: 'seq-1' }, 1))
        await until((): boolean => messages === 1)
        if (enabled) {
          streams[0]!.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'account', throughSeq: 1 }))
          await until((): boolean => service.recoveryState.status === 'ready')
          t.equal((await service.getMiscellaneousStoreData()).lastEventSeq, '1', 'recovery persists seq 1 even when event cache is disabled')
          t.equal((await service.getMiscellaneousStoreData()).accountId, 'account', 'recovery persists account identity')
          streams[0]!.end()
          await until((): boolean => service.recoveryState.status === 'recovering')
          await until((): boolean => streams.length === 2)
          t.equal(streams[1]!.request.getSeq(), 1, 'reconnect resumes the durable cursor, not zero')
          t.equal(streams[1]!.request.getAccountId(), 'account', 'reconnect retains the account binding')
          streams[1]!.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }))
          streams[1]!.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
          streams[1]!.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'account', throughSeq: 1 }))
          await until((): boolean => service.recoveryState.status === 'ready')
          t.equal(service.recoveryState.status, 'ready', 'durable throughSeq 1 unlocks the reconnected stream')
        } else {
          await service.setMiscellaneousStoreData({ accountId: 'ignored', lastEventSeq: '99' })
          t.equal(service.eventMetadataStore, undefined, 'legacy disabled-cache clients do not allocate a metadata store')
          t.same(await service.getMiscellaneousStoreData(), { accountId: '', lastEventSeq: undefined, lastEventTimestamp: undefined }, 'legacy metadata operations remain disabled')
        }
        t.same(errors, [], 'neither mode masks a stream or persistence error')
      } finally { await service.onStop(); await service.destroyTestStore(); server.forceShutdown() }
    }
    const service = new RecoveryTestService({ token: `insecure_cursor-read-error-${process.pid}`, recovery: { enabled: true } })
    service.on('error', (): void => {})
    try {
      assert.ok(service.eventMetadataStore, 'recovery must allocate cursor storage independently of event caching')
      const failure = new Error('external cursor storage read failed')
      const read = sinon.stub(service.eventMetadataStore, 'get').rejects(failure)
      try {
        await assert.rejects(service.onStart(), failure)
        assert.throws((): void => { void service.grpcManager }, /no grpc manager/, 'failed cursor read releases the manager')
      } finally { read.restore() }
    } finally { await service.onStop(); await service.destroyTestStore() }
  } finally {
    if (previous === undefined) { delete process.env['WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE'] } else { process.env['WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE'] = previous }
  }
})
