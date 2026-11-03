import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { sinon, test } from 'tstest'

import { PuppetService } from './puppet-service.js'

class RefreshService extends PuppetService {

  get store () { return this._payloadStore }
  get manager () { return this._grpcManager }
  async cleanup (): Promise<void> { await this.onStop(); await this.store.destroy() }

}

function deferred<T = void> () {
  let resolveDeferred!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolve => { resolveDeferred = resolve })
  return { promise, resolve: resolveDeferred }
}

async function bounded<T> (promise: Promise<T>, milliseconds = 4000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([ promise, new Promise<never>((_resolve, reject): void => {
      timer = setTimeout((): void => { reject(new Error('test deadline exceeded')) }, milliseconds)
    }) ])
  } finally { clearTimeout(timer) }
}

async function waitUntil (condition: () => boolean, message: string, milliseconds = 3000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!condition()) {
    if (Date.now() >= deadline) { throw new assert.AssertionError({ message }) }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function event (type: ReturnType<puppet.EventResponse['getType']>, payload: unknown): puppet.EventResponse {
  const response = new puppet.EventResponse()
  response.setType(type); response.setPayload(JSON.stringify(payload)); response.setSeq(0)
  return response
}

async function endpoint (name: string) {
  const server = new grpc.Server()
  const reopened = deferred()
  const connected = deferred<grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>>()
  const state = { streams: 0, holdReopen: false, holdReady: false, sends: [] as string[], starts: 0, stops: 0 }
  const ready = (stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
    stream.write(event(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }))
    stream.write(event(puppet.EventType.EVENT_TYPE_READY, {}))
    stream.write(event(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'account', throughSeq: 0 }))
  }
  server.addService(puppet.PuppetService, {
    event: (stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      state.streams++
      if (state.streams > 1) {
        reopened.resolve()
        // Hold before the initial heartbeat so startStream really remains pending.
        if (state.holdReopen) { return }
      }
      stream.write(event(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}))
      connected.resolve(stream)
      if (!state.holdReady) { ready(stream) }
    },
    start: (_call: unknown, callback: grpc.sendUnaryData<puppet.StartResponse>): void => {
      state.starts++; callback(null, new puppet.StartResponse())
    },
    stop: (_call: unknown, callback: grpc.sendUnaryData<puppet.StopResponse>): void => {
      state.stops++; callback(null, new puppet.StopResponse())
    },
    messageSendText: (call: grpc.ServerUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>, callback: grpc.sendUnaryData<puppet.MessageSendTextResponse>): void => {
      state.sends.push(call.request.getText())
      const response = new puppet.MessageSendTextResponse(); response.setId(name); callback(null, response)
    },
  })
  const port = await bounded(new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => {
      error ? reject(error) : resolve(value)
    })
  }))
  return { server, state, ready, connected: connected.promise, reopened: reopened.promise, address: `127.0.0.1:${port}` }
}

type Endpoint = Awaited<ReturnType<typeof endpoint>>

async function withFixture (recovery: boolean, body: (a: Endpoint, b: Endpoint, service: RefreshService, errors: unknown[]) => Promise<void>): Promise<void> {
  let a: Endpoint | undefined
  let b: Endpoint | undefined
  let service: RefreshService | undefined
  try {
    a = await endpoint('A'); b = await endpoint('B')
    service = new RefreshService({
      token: `insecure_${randomUUID()}`,
      endpoint: a.address,
      tls: { disable: true },
      recovery: { enabled: recovery, inactivityMilliseconds: 45_000 },
    })
    sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
    const errors: unknown[] = []
    service.on('error', (error): void => { errors.push(error) })
    const loggedIn = new Promise<void>(resolve => service!.once('login', (): void => { resolve() }))
    await bounded(service.onStart()); await bounded(loggedIn)
    if (recovery) { await waitUntil(() => service!.recoveryState.status === 'ready', 'startup gate ready') }
    await body(a, b, service, errors)
  } finally {
    try { if (service) { await bounded(service.cleanup(), 12000) } } finally {
      a?.server.forceShutdown(); b?.server.forceShutdown(); sinon.restore()
    }
  }
}

test('failed rollback preserves the final-check error and promptly hands A to recovery', async t => {
  await withFixture(true, async (a, b, service) => {
    const refused = new Error('final route check refused')
    const refreshing = service.replaceEndpoint(b.address, {
      deadline: Date.now() + 5000,
      beforePublish: async () => {
        a.server.forceShutdown()
        throw refused
      },
    })
    await assert.rejects(bounded(refreshing, 8000), (error: unknown) => error === refused)
    await waitUntil(() => service.recoveryState.status === 'recovering', 'A recovery was not requested')
    assert.equal(service.options.endpoint, a.address)
    assert.equal(b.state.starts, 0)
    t.pass('the original refusal is retained and recovery resumes without the 45-second inactivity delay')
  })
})

test('healthy rollback retains the original error and A still sends normally', async t => {
  await withFixture(true, async (a, b, service) => {
    const refused = new Error('final route check refused')
    await assert.rejects(bounded(service.replaceEndpoint(b.address, {
      deadline: Date.now() + 5000,
      beforePublish: async () => { throw refused },
    })), (error: unknown) => error === refused)
    await bounded(a.reopened)
    await waitUntil(() => service.recoveryState.status === 'ready', 'healthy A ready')
    assert.equal(await bounded(service.messageSendText('peer', 'after-rollback')), 'A')
    assert.deepEqual(a.state.sends, [ 'after-rollback' ])
    assert.deepEqual(b.state.sends, [])
    t.pass('the original endpoint remains usable')
  })
})

test('stop during the real rollback connection wait cannot revive A', async t => {
  await withFixture(true, async (a, b, service) => {
    const refused = new Error('final route check refused')
    a.state.holdReopen = true
    const refreshing = service.replaceEndpoint(b.address, {
      deadline: Date.now() + 5000,
      beforePublish: async () => { throw refused },
    })
    void refreshing.catch(() => undefined)
    await bounded(a.reopened)
    await bounded(service.onStop())
    await assert.rejects(bounded(refreshing), (error: unknown) => error === refused)
    assert.equal(service.manager, undefined)
    assert.equal(Reflect.get(service, 'recoveryTimer'), undefined)
    assert.equal(a.state.streams, 2)
    assert.equal(a.state.stops, 1)
    assert.equal(b.state.starts, 0)
    t.pass('stop owns the final state and no recovery is scheduled')
  })
})

test('without recovery, failed rollback reports one stream error and keeps the original refusal', async t => {
  await withFixture(false, async (a, b, service, errors) => {
    const refused = new Error('final route check refused')
    await assert.rejects(bounded(service.replaceEndpoint(b.address, {
      deadline: Date.now() + 5000,
      beforePublish: async () => { a.server.forceShutdown(); throw refused },
    }), 8000),
    (error: unknown) => error === refused)
    assert.equal(errors.length, 1)
    // Puppet's public error event carries serialized GError, not the raw Error.
    const payload = errors[0] as { gerror: string }
    assert.equal(typeof payload.gerror, 'string')
    const reported = JSON.parse(payload.gerror) as { message: string }
    assert.match(reported.message, /UNAVAILABLE|ECONNREFUSED/)
    assert.notEqual(reported.message, refused.message)
    assert.equal(Reflect.get(service, 'recoveryTimer'), undefined)
    assert.equal(service.options.endpoint, a.address)
    assert.equal(b.state.starts, 0)
    t.pass('the rollback transport failure is observable without enabling background recovery')
  })
})

test('without recovery, successful rollback does not newly report an error deferred before sealing', async t => {
  await withFixture(false, async (a, b, service, errors) => {
    const refused = new Error('final route check refused')
    b.state.holdReady = true
    const refreshing = service.replaceEndpoint(b.address, {
      deadline: Date.now() + 5000,
      beforePublish: async () => { throw refused },
    })
    void refreshing.catch(() => undefined)
    const candidateStream = await bounded(b.connected)
    // Inject at the manager's real error bridge; this test concerns deferred notification ownership,
    // not how grpc-js translates a server-side Writable.destroy into a transport event.
    service.manager!.emit('error', new Error('old stream failed before sealing'))
    await waitUntil(() => {
      const operation = Reflect.get(service, 'endpointReplacement') as { sealed: boolean, oldError?: unknown } | undefined
      return !!operation && !operation.sealed && operation.oldError !== undefined
    }, 'old error must be deferred before candidate handshake finishes')
    b.ready(candidateStream)
    await assert.rejects(bounded(refreshing), (error: unknown) => error === refused)
    await bounded(a.reopened)
    assert.equal(await bounded(service.messageSendText('peer', 'after-healthy-rollback')), 'A')
    assert.deepEqual(errors, [], 'successful rollback preserves its original error notification behavior')
    assert.equal(Reflect.get(service, 'recoveryTimer'), undefined)
    t.pass('a historical stream error does not turn healthy rollback into a new error notification')
  })
})
