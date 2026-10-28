import assert from 'node:assert/strict'
import util from 'node:util'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { test } from 'tstest'

import { RecoveryGate, withRecoveryRequestContext } from './recovery.js'
import { PuppetService } from './puppet-service.js'

type SendHandler = grpc.handleUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>

class AdmissionService extends PuppetService {

  protected override hookPayloadStore (): void {}
  override async login (_contactId: string): Promise<void> {}
  async destroyStore (): Promise<void> { await this._payloadStore.destroy() }

}

function rejectedMetadata (state = 'not-submitted', capability = 'admission-reject-v1'): grpc.Metadata {
  const metadata = new grpc.Metadata()
  if (state) { metadata.set('x-juzi-request-state', state) }
  if (capability) { metadata.set('x-juzi-recovery-capability', capability) }
  return metadata
}

function ready (gate: RecoveryGate): void {
  gate.login('account'); gate.ready(); gate.barrier('account')
}

async function fixture (gate: RecoveryGate, handler: SendHandler): Promise<{ client: puppet.PuppetClient, close(): void }> {
  const server = new grpc.Server()
  server.addService(puppet.PuppetService, { messageSendText: handler })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const client = new puppet.PuppetClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), { interceptors: [ gate.interceptor ], 'grpc.enable_retries': 0 })
  gate.begin('account'); ready(gate)
  return { client, close: (): void => { gate.fail('test cleanup'); client.close(); server.forceShutdown() } }
}

test('opt-in unary retries only proven unsubmitted attempts and preserves the payload', async t => {
  const gate = new RecoveryGate({ enabled: true })
  let attempts = 0
  let executions = 0
  const capabilities: unknown[] = []
  const received: string[] = []
  const request = new puppet.MessageSendTextRequest(); request.setText('original')
  const endpoint = await fixture(gate, (call, callback): void => {
    attempts++
    capabilities.push(call.metadata.get('x-juzi-recovery-capability'))
    received.push(call.request.getText())
    if (attempts <= 2) {
      gate.begin('account')
      callback({ code: grpc.status.UNAVAILABLE, details: 'not admitted', metadata: rejectedMetadata() })
      request.setText('mutated after first attempt')
      setTimeout((): void => { ready(gate) }, 20)
      return
    }
    executions++
    const result = new puppet.MessageSendTextResponse(); result.setId('executed')
    callback(null, result)
  })
  try {
    const response = await withRecoveryRequestContext({ deadline: Date.now() + 2000 }, async (): Promise<puppet.MessageSendTextResponse> => util.promisify(endpoint.client.messageSendText.bind(endpoint.client))(request))
    assert.equal(response.getId(), 'executed')
    assert.equal(attempts, 3)
    assert.equal(executions, 1)
    assert.deepEqual(capabilities, Array.from({ length: 3 }, (): string[] => [ 'admission-reject-v1' ]))
    assert.deepEqual(received, [ 'original', 'original', 'original' ])
    t.pass('multiple non-admissions lead to one business execution')
  } finally { endpoint.close() }
})

test('unavailable without both exact trailers, other codes and disabled recovery never replay', async t => {
  const cases = [
    { state: '', capability: '', code: grpc.status.UNAVAILABLE, enabled: true },
    { state: 'not-submitted', capability: '', code: grpc.status.UNAVAILABLE, enabled: true },
    { state: '', capability: 'admission-reject-v1', code: grpc.status.UNAVAILABLE, enabled: true },
    { state: 'submitted', capability: 'admission-reject-v1', code: grpc.status.UNAVAILABLE, enabled: true },
    { state: 'not-submitted', capability: 'unknown', code: grpc.status.UNAVAILABLE, enabled: true },
    { state: 'not-submitted', capability: 'admission-reject-v1', code: grpc.status.INTERNAL, enabled: true },
    { state: 'not-submitted', capability: 'admission-reject-v1', code: grpc.status.UNAVAILABLE, enabled: false },
  ]
  for (const scenario of cases) {
    const gate = new RecoveryGate({ enabled: scenario.enabled })
    let attempts = 0
    let capabilities: unknown[] = []
    const endpoint = await fixture(gate, (call, callback): void => {
      attempts++; capabilities = call.metadata.get('x-juzi-recovery-capability')
      callback({ code: scenario.code, details: 'terminal', metadata: rejectedMetadata(scenario.state, scenario.capability) })
    })
    try {
      await assert.rejects(util.promisify(endpoint.client.messageSendText.bind(endpoint.client))(new puppet.MessageSendTextRequest()), /terminal/)
      assert.equal(attempts, 1)
      assert.deepEqual(capabilities, scenario.enabled ? [ 'admission-reject-v1' ] : [])
    } finally { endpoint.close() }
  }
  t.pass('no heuristic network retries and no partial protocol matches')
})

test('repeated non-admission keeps the original deadline and abort never submits a delayed attempt', async t => {
  for (const mode of [ 'deadline', 'abort' ] as const) {
    const gate = new RecoveryGate({ enabled: true })
    const controller = new AbortController()
    let attempts = 0
    const deadlines: number[] = []
    const endpoint = await fixture(gate, (call, callback): void => {
      attempts++
      const deadline = call.getDeadline()
      deadlines.push(deadline instanceof Date ? deadline.getTime() : deadline)
      gate.begin('account')
      callback({ code: grpc.status.UNAVAILABLE, details: 'not admitted', metadata: rejectedMetadata() })
      setTimeout((): void => { if (mode === 'abort') { controller.abort() }; ready(gate) }, 10)
    })
    try {
      const deadline = Date.now() + 240
      const result = withRecoveryRequestContext({ deadline, signal: controller.signal }, async (): Promise<puppet.MessageSendTextResponse> => util.promisify(endpoint.client.messageSendText.bind(endpoint.client))(new puppet.MessageSendTextRequest()))
      await assert.rejects(result, mode === 'deadline' ? /DEADLINE_EXCEEDED/ : /CANCELLED/)
      assert.ok(Date.now() <= deadline + 100)
      assert.ok(deadlines.every(value => value <= deadline + 5))
      assert.equal(attempts, mode === 'abort' ? 1 : 3)
    } finally { endpoint.close() }
  }
  t.pass('backoff is finite; original deadline and cancellation remain authoritative')
})

test('requeued attempts reserve request and payload capacity again', async t => {
  for (const mode of [ 'requests', 'bytes' ]) {
    const gate = new RecoveryGate({ enabled: true, maxPendingRequests: mode === 'requests' ? 1 : 10, maxPendingBytes: mode === 'bytes' ? 64 : 1024 })
    const callbacks: grpc.sendUnaryData<puppet.MessageSendTextResponse>[] = []
    const accepted: (() => void)[] = []
    const arrivals = [ 0, 1 ].map(() => new Promise<void>((resolve): void => { accepted.push(resolve) }))
    let executions = 0
    const endpoint = await fixture(gate, (_call, callback): void => {
      if (callbacks.length < 2) { callbacks.push(callback); accepted[callbacks.length - 1]!(); return }
      executions++
      callback(null, new puppet.MessageSendTextResponse())
    })
    try {
      const send = async (): Promise<puppet.MessageSendTextResponse> => {
        const request = new puppet.MessageSendTextRequest(); request.setText('x'.repeat(40))
        return withRecoveryRequestContext({ deadline: Date.now() + 2000 }, async (): Promise<puppet.MessageSendTextResponse> => util.promisify(endpoint.client.messageSendText.bind(endpoint.client))(request))
      }
      const first = send(); await arrivals[0]
      const second = send(); await arrivals[1]
      const results = Promise.allSettled([ first, second ])
      gate.begin('account')
      for (const callback of callbacks) { callback({ code: grpc.status.UNAVAILABLE, details: 'rejected', metadata: rejectedMetadata() }) }
      await new Promise<void>((resolve): void => { setTimeout(resolve, 30) })
      ready(gate)
      const settled = await results
      assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1)
      const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')!
      assert.match(String(failed.reason), /RESOURCE_EXHAUSTED/)
      assert.equal(executions, 1)
    } finally { endpoint.close() }
  }
  t.pass('non-admission does not bypass either recovery queue budget')
})

test('logout, changed epoch and local prepare fence pending retries', async t => {
  for (const mode of [ 'logout', 'session', 'prepare', 'event', 'account' ]) {
    const gate = new RecoveryGate({ enabled: true })
    let attempts = 0
    let currentEvent = true
    const endpoint = await fixture(gate, (_call, callback): void => {
      attempts++
      gate.begin('account')
      callback({ code: grpc.status.UNAVAILABLE, details: 'not admitted', metadata: rejectedMetadata() })
      setTimeout((): void => {
        if (mode === 'logout') { gate.fail('Account logged out'); return }
        if (mode === 'account') { gate.checkAccount('other'); return }
        if (mode === 'session') { gate.begin('account', true) }
        if (mode === 'prepare') { gate.stopAdmissionRetries() }
        if (mode === 'event') { currentEvent = false }
        ready(gate)
      }, 10)
    })
    try {
      const send = async (): Promise<puppet.MessageSendTextResponse> => withRecoveryRequestContext({ deadline: Date.now() + 500 }, async (): Promise<puppet.MessageSendTextResponse> => util.promisify(endpoint.client.messageSendText.bind(endpoint.client))(new puppet.MessageSendTextRequest()))
      const result = mode === 'event' ? gate.runEvent((): boolean => currentEvent, send) : send()
      await assert.rejects(result, /logged out|Superseded|preparation|Account changed/)
      assert.equal(attempts, 1)
    } finally { endpoint.close() }
  }
  t.pass('no attempt crosses terminal/session/event/local-stop fences')
})

test('a real response message forbids retry even with both rejection trailers', async t => {
  const gate = new RecoveryGate({ enabled: true })
  const server = new grpc.Server()
  let attempts = 0
  server.addService({ send: { ...puppet.PuppetService.messageSendText, responseStream: true } }, {
    send: (call: grpc.ServerWritableStream<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>): void => {
      attempts++
      const response = new puppet.MessageSendTextResponse(); response.setId('already-executed')
      call.write(response)
      setTimeout((): void => { call.emit('error', { code: grpc.status.UNAVAILABLE, details: 'after response', metadata: rejectedMetadata() }) }, 10)
    },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const client = new puppet.PuppetClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), { interceptors: [ gate.interceptor ], 'grpc.enable_retries': 0 })
  gate.begin('account'); ready(gate)
  try {
    await assert.rejects(util.promisify(client.messageSendText.bind(client))(new puppet.MessageSendTextRequest()), /after response/)
    assert.equal(attempts, 1)
    assert.equal(gate.state.status, 'ready')
    t.pass('a received business response overrides the claimed non-admission')
  } finally { gate.fail('cleanup'); client.close(); server.forceShutdown() }
})

test('controls and streaming calls do not opt in or retry', async t => {
  const gate = new RecoveryGate({ enabled: true })
  const server = new grpc.Server()
  const capabilities: unknown[] = []
  server.addService(puppet.PuppetService, {
    ding: (call: grpc.ServerUnaryCall<puppet.DingRequest, puppet.DingResponse>, callback: grpc.sendUnaryData<puppet.DingResponse>): void => {
      capabilities.push(call.metadata.get('x-juzi-recovery-capability'))
      callback({ code: grpc.status.UNAVAILABLE, details: 'control rejected', metadata: rejectedMetadata() })
    },
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      capabilities.push(call.metadata.get('x-juzi-recovery-capability'))
      call.emit('error', { code: grpc.status.UNAVAILABLE, details: 'stream rejected', metadata: rejectedMetadata() })
    },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const client = new puppet.PuppetClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), { interceptors: [ gate.interceptor ], 'grpc.enable_retries': 0 })
  gate.begin('account'); ready(gate)
  try {
    await assert.rejects(util.promisify(client.ding.bind(client))(new puppet.DingRequest()), /control rejected/)
    await assert.rejects(new Promise<void>((_resolve, reject): void => { client.event(new puppet.EventRequest()).on('error', reject) }), /stream rejected/)
    assert.deepEqual(capabilities, [ [], [] ])
    t.pass('control and stream calls retain one-shot semantics')
  } finally { gate.fail('cleanup'); client.close(); server.forceShutdown() }
})

test('PuppetService closes the ready-window race but prepare prevents recovery reopening', async t => {
  for (const mode of [ 'recover', 'prepare' ]) {
    const server = new grpc.Server()
    let streams = 0
    let executions = 0
    let attempts = 0
    let rejected!: grpc.sendUnaryData<puppet.MessageSendTextResponse>
    let received!: () => void
    const reception = new Promise<void>((resolve): void => { received = resolve })
    server.addService(puppet.PuppetService, {
      event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
        streams++
        for (const [ type, payload ] of [
          [ puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' } ],
          [ puppet.EventType.EVENT_TYPE_READY, {} ],
          [ puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'account', throughSeq: 0 } ],
        ] as const) {
          const response = new puppet.EventResponse()
          response.setType(type); response.setPayload(JSON.stringify(payload)); call.write(response)
        }
      },
      start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { callback(null, new puppet.StartResponse()) },
      stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
      messageSendText: (_call: grpc.ServerUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>, callback: grpc.sendUnaryData<puppet.MessageSendTextResponse>): void => {
        attempts++
        if (attempts === 1) { rejected = callback; received(); return }
        executions++
        const response = new puppet.MessageSendTextResponse(); response.setId('sent-once'); callback(null, response)
      },
    })
    const port = await new Promise<number>((resolve, reject): void => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
    })
    const service = new AdmissionService({ token: `insecure_admission-${mode}-${port}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: true } })
    service.on('error', (): void => {})
    try {
      await service.onStart()
      const sending = service.withRecoveryRequestContext({ deadline: Date.now() + 3000 }, async (): Promise<string | void> => service.messageSendText('contact', 'message'))
      await reception
      assert.equal(service.recoveryState.status, 'ready')
      if (mode === 'prepare') { await service.prepareForRestart({ deadline: Date.now() + 1000 }) }
      rejected({ code: grpc.status.UNAVAILABLE, details: 'not admitted', metadata: rejectedMetadata() })
      if (mode === 'recover') {
        assert.equal(await sending, 'sent-once')
        assert.equal(streams, 2)
        assert.equal(executions, 1)
      } else {
        await assert.rejects(sending, /not admitted/)
        await service.reset()
        assert.equal(streams, 1)
        assert.equal(executions, 0)
      }
    } finally { await service.onStop(); await service.destroyStore(); server.forceShutdown() }
  }
  t.pass('non-admission forces recovery before requeue unless locally preparing')
})

test('direct call cancellation terminates a queued retry exactly once', async t => {
  const gate = new RecoveryGate({ enabled: true })
  let attempts = 0
  let received!: () => void
  const reception = new Promise<void>((resolve): void => { received = resolve })
  const endpoint = await fixture(gate, (_call, callback): void => {
    attempts++
    gate.begin('account')
    callback({ code: grpc.status.UNAVAILABLE, details: 'not admitted', metadata: rejectedMetadata() })
    received()
  })
  let callbacks = 0
  let statuses = 0
  let call!: grpc.ClientUnaryCall
  const result = new Promise<puppet.MessageSendTextResponse>((resolve, reject): void => {
    call = endpoint.client.messageSendText(new puppet.MessageSendTextRequest(), (error, response): void => {
      callbacks++; error ? reject(error) : resolve(response)
    })
    call.on('status', (): void => { statuses++ })
  })
  const rejected = assert.rejects(result, /CANCELLED/)
  try {
    await reception
    await new Promise<void>((resolve): void => { setTimeout(resolve, 20) })
    assert.equal(typeof call.getPeer(), 'string')
    assert.equal(call.getAuthContext(), null)
    call.cancel(); call.cancel()
    await rejected
    ready(gate)
    await new Promise<void>((resolve): void => { setTimeout(resolve, 60) })
    assert.equal(attempts, 1)
    assert.equal(callbacks, 1)
    assert.equal(statuses, 1)
    t.pass('cancel fences late attempts and exposes one terminal status')
  } finally { endpoint.close() }
})

test('calls without a caller deadline have one finite non-renewing retry budget', async t => {
  const gate = new RecoveryGate({ enabled: true, maxRecoveryMilliseconds: 100 })
  let attempts = 0
  const endpoint = await fixture(gate, (_call, callback): void => {
    attempts++
    gate.begin('account')
    callback({ code: grpc.status.UNAVAILABLE, details: 'not admitted', metadata: rejectedMetadata() })
    setTimeout((): void => { ready(gate) }, 10)
  })
  try {
    const started = Date.now()
    await assert.rejects(util.promisify(endpoint.client.messageSendText.bind(endpoint.client))(new puppet.MessageSendTextRequest()), /DEADLINE_EXCEEDED/)
    assert.equal(attempts, 2)
    assert.ok(Date.now() - started < 250)
    t.pass('ready transitions cannot replenish the logical requeue deadline')
  } finally { endpoint.close() }
})
