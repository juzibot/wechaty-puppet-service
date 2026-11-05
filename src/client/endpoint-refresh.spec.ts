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

// Polls with its own deadline, so a failed condition ends the loop instead of outliving the test.
async function waitUntil (condition: () => boolean, message: string, milliseconds = 4000, interval = 10): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!condition()) {
    if (Date.now() >= deadline) { throw new assert.AssertionError({ message: `waitUntil timed out: ${message}` }) }
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

function event (type: ReturnType<puppet.EventResponse['getType']>, payload: unknown, seq = 0): puppet.EventResponse {
  const response = new puppet.EventResponse()
  response.setType(type); response.setPayload(JSON.stringify(payload)); response.setSeq(seq)
  return response
}

async function endpoint (name: string, account = 'account', holdReady = false) {
  const server = new grpc.Server()
  const connected = deferred<grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>>()
  const sent = deferred<grpc.sendUnaryData<puppet.MessageSendTextResponse>>()
  const state = { starts: 0, stops: 0, sends: [] as string[], cursors: [] as number[], holdSend: false }
  const streams = new Set<grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>>()
  const ready = (stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
    stream.write(event(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: account }))
    stream.write(event(puppet.EventType.EVENT_TYPE_READY, {}))
    stream.write(event(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: account, throughSeq: 0 }))
  }
  server.addService(puppet.PuppetService, {
    event: (stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      streams.add(stream); state.cursors.push(stream.request.getSeq()); connected.resolve(stream)
      stream.on('cancelled', (): void => { streams.delete(stream) })
      stream.write(event(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}))
      if (!holdReady) ready(stream)
    },
    start: (_call: unknown, callback: grpc.sendUnaryData<puppet.StartResponse>): void => {
      state.starts++; callback(null, new puppet.StartResponse())
    },
    stop: (_call: unknown, callback: grpc.sendUnaryData<puppet.StopResponse>): void => {
      state.stops++; callback(null, new puppet.StopResponse())
    },
    messageSendText: (call: grpc.ServerUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>, callback: grpc.sendUnaryData<puppet.MessageSendTextResponse>): void => {
      state.sends.push(call.request.getText())
      if (state.holdSend) { sent.resolve(callback); return }
      const response = new puppet.MessageSendTextResponse(); response.setId(name); callback(null, response)
    },
    ding: (call: grpc.ServerUnaryCall<puppet.DingRequest, puppet.DingResponse>, callback: grpc.sendUnaryData<puppet.DingResponse>): void => {
      for (const stream of streams) stream.write(event(puppet.EventType.EVENT_TYPE_DONG, { data: `${name}:${call.request.getData()}` }))
      callback(null, new puppet.DingResponse())
    },
  })
  const port = await bounded(new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  }))
  return { server, state, connected: connected.promise, sent: sent.promise, ready, address: `127.0.0.1:${port}` }
}

async function running (address: string, recovery = false): Promise<RefreshService> {
  const service = new RefreshService({ token: `insecure_${randomUUID()}`, endpoint: address, tls: { disable: true }, recovery: { enabled: recovery } })
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  service.on('error', (): void => {})
  const loggedIn = new Promise<void>(resolve => service.once('login', (): void => { resolve() }))
  await bounded(service.onStart()); await bounded(loggedIn)
  return service
}

type Refresh = (endpoint: string, options: { deadline: number, beforePublish?: () => Promise<void> }) => Promise<void>
function replace (service: RefreshService, address: string, beforePublish?: () => Promise<void>): Promise<void> {
  const method = Reflect.get(service, 'replaceEndpoint') as Refresh | undefined
  if (method) return method.call(service, address, { deadline: Date.now() + 3000, beforePublish })
  // Before the fix, writing the new endpoint leaves the existing live channel unchanged.
  service.options.endpoint = address
  return Promise.resolve()
}

test('migration refresh sends RPC and receives Event on B without remote Start/Stop', async t => {
  const a = await endpoint('A'); const b = await endpoint('B'); const service = await running(a.address)
  try {
    assert.equal(await bounded(service.messageSendText('peer', 'before')), 'A')
    await replace(service, b.address)
    assert.equal(await bounded(service.messageSendText('peer', 'after')), 'B')
    const received = new Promise<string>(resolve => service.once('dong', value => resolve(value.data ?? '')))
    service.ding('after-refresh')
    assert.equal(await bounded(received), 'B:after-refresh')
    assert.deepEqual([ a.state.starts, a.state.stops, b.state.starts, b.state.stops ], [ 1, 0, 0, 0 ])
    t.pass('the running transport changed, not just an endpoint field or HTTP ACK')
  } finally { await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})

test('recovery-enabled transport can replace a disconnected source and remains ready on B', async t => {
  const a = await endpoint('A'); const b = await endpoint('B'); const service = await running(a.address, true)
  try {
    await bounded(service.messageSendText('peer', 'before'))
    const old = service.manager!
    old.emit('end')
    assert.equal(service.recoveryState.status, 'recovering')
    await bounded(replace(service, b.address))
    assert.equal(await bounded(service.messageSendText('peer', 'after')), 'B')
    assert.equal(service.recoveryState.status, 'ready')
    assert.deepEqual([ a.state.starts, a.state.stops, b.state.starts, b.state.stops ], [ 1, 0, 0, 0 ])
    t.pass('recovery completes on the replacement without a remote lifecycle RPC')
  } finally { await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})

test('a transport-error local logout still validates the last authenticated account', async t => {
  const a = await endpoint('A'); const b = await endpoint('B'); const service = await running(a.address)
  try {
    // Existing Nested error recovery clears this field after emitting a local logout.
    Reflect.set(service, '__currentUserId', undefined)
    assert.equal(service.isLoggedIn, false)
    await bounded(replace(service, b.address))
    assert.equal(await bounded(service.messageSendText('peer', 'after')), 'B')
    t.pass('a disconnected running object does not need a destructive ordinary restart')
  } finally { await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})

test('final route check runs after cursor preparation and stop cancels publication', async t => {
  const a = await endpoint('A'); const b = await endpoint('B'); const service = await running(a.address)
  const prepared = deferred(); const release = deferred()
  try {
    const store = service.store.miscellaneous!
    const original = store.set.bind(store)
    sinon.stub(store, 'set').callsFake(async (key, value) => {
      if (key === 'lastEventSeq' && value === '0') { prepared.resolve(); await release.promise }
      return original(key, value)
    })
    let finalCheck = false
    const refreshing = replace(service, b.address, async (): Promise<void> => { finalCheck = true })
    void refreshing.catch(() => undefined)
    await bounded(prepared.promise)
    assert.equal(finalCheck, false, 'last route authority check must not precede async cursor writes')
    const stopping = service.onStop()
    release.resolve()
    await assert.rejects(bounded(refreshing), /cancel|superseded/)
    await bounded(stopping)
    assert.equal(service.manager, undefined)
    t.pass('late cursor completion cannot publish or reopen a stopped transport')
  } finally { release.resolve(); await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})

test('a submitted RPC survives publication; ordinary stop closes retired channels locally', async t => {
  const a = await endpoint('A'); const b = await endpoint('B'); const service = await running(a.address)
  let finish: grpc.sendUnaryData<puppet.MessageSendTextResponse> | undefined
  let pending: Promise<string | void> | undefined
  try {
    const old = service.manager!
    a.state.holdSend = true
    pending = service.messageSendText('peer', 'submitted-before-switch')
    void pending.catch(() => undefined)
    finish = await bounded(a.sent)
    await bounded(replace(service, b.address))
    assert.equal(await bounded(service.messageSendText('peer', 'new')), 'B')
    await bounded(service.onStop())
    await assert.rejects(bounded(pending), /cancel|closed|unavailable/i)
    assert.throws(() => old.client, /client/i)
    assert.deepEqual([ a.state.stops, b.state.stops ], [ 0, 1 ])
    t.pass('only the current remote puppet is stopped; old local channels cannot leak')
  } finally {
    if (finish) finish(null, new puppet.MessageSendTextResponse())
    await pending?.catch(() => undefined)
    await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore()
  }
})

test('refresh preserves an accepted old listener and its real in-flight RPC', async t => {
  const a = await endpoint('A'); const b = await endpoint('B'); const service = await running(a.address)
  const release = deferred(); const entered = deferred()
  const completed: string[] = []
  let inFlight: Promise<void | string> | undefined
  let finish: grpc.sendUnaryData<puppet.MessageSendTextResponse> | undefined
  service.on('dong', async value => {
    if (value.data !== 'old-event') return
    entered.resolve(); await release.promise
    completed.push(String(await service.messageSendText('peer', 'old-listener-send')))
  })
  try {
    const stream = await a.connected
    stream.write(event(puppet.EventType.EVENT_TYPE_DONG, { data: 'old-event' }, 17))
    await bounded(entered.promise)
    a.state.holdSend = true
    inFlight = service.messageSendText('peer', 'already-sent')
    void inFlight.catch(() => undefined)
    finish = await bounded(a.sent)
    let switched = false
    const refreshing = replace(service, b.address).then((): void => { switched = true; return undefined })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(switched, false)
    a.state.holdSend = false
    const response = new puppet.MessageSendTextResponse(); response.setId('A-inflight'); finish(null, response); finish = undefined
    assert.equal(await bounded(inFlight), 'A-inflight')
    release.resolve(); await bounded(refreshing)
    assert.deepEqual(completed, [ 'A' ])
    assert.equal(await bounded(service.messageSendText('peer', 'new-send')), 'B')
    assert.deepEqual(b.state.cursors, [ 0 ], 'never use an unrelated source sequence on the target')
    t.pass('accepted work finishes on its original channel before publication')
  } finally {
    a.state.holdSend = false
    if (finish) finish(null, new puppet.MessageSendTextResponse())
    release.resolve()
    await inFlight?.catch(() => undefined)
    await new Promise<void>(resolve => setImmediate(resolve))
    await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore()
  }
})

test('ordinary stop cancels a candidate waiting for READY and late work cannot revive it', async t => {
  const a = await endpoint('A'); const b = await endpoint('B', 'account', true); const service = await running(a.address)
  try {
    assert.equal(typeof Reflect.get(service, 'replaceEndpoint'), 'function')
    const refreshing = replace(service, b.address).then(() => 'published', () => 'cancelled')
    const candidate = await bounded(b.connected)
    await bounded(service.onStop())
    b.ready(candidate)
    assert.equal(await bounded(refreshing), 'cancelled')
    assert.equal(service.manager, undefined)
    assert.deepEqual([ a.state.starts, a.state.stops, b.state.starts, b.state.stops ], [ 1, 1, 0, 0 ])
    t.pass('stop keeps its original remote Stop and never waits for the replacement handshake')
  } finally { await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})

test('wrong-account target or stale-route final check leaves the current connection on A', async t => {
  const a = await endpoint('A'); const wrong = await endpoint('wrong', 'other-account'); const b = await endpoint('B')
  const service = await running(a.address)
  try {
    await assert.rejects(replace(service, wrong.address), /account/i)
    assert.equal(await bounded(service.messageSendText('peer', 'still-A')), 'A')
    await assert.rejects(replace(service, b.address, async () => { throw new Error('route superseded') }), /superseded/)
    assert.equal(await bounded(service.messageSendText('peer', 'still-A-again')), 'A')
    assert.equal(service.options.endpoint, a.address)
    t.pass('failed candidates do not publish or overwrite the runtime endpoint')
  } finally { await service.cleanup(); a.server.forceShutdown(); wrong.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})

test('candidate replay deduplicates the same positive sequence before publication', async t => {
  const a = await endpoint('A'); const b = await endpoint('B', 'account', true); const service = await running(a.address)
  const delivered: string[] = []
  service.on('dong', value => { if (value.data) delivered.push(value.data) })
  try {
    const refreshing = replace(service, b.address)
    const stream = await bounded(b.connected)
    stream.write(event(puppet.EventType.EVENT_TYPE_DONG, { data: 'target-buffered' }, 12))
    stream.write(event(puppet.EventType.EVENT_TYPE_DONG, { data: 'target-buffered' }, 12))
    b.ready(stream)
    await bounded(refreshing)
    // Wait for B's own later DONG so every buffered replay has been delivered first.
    const flushed = new Promise<void>(resolve => service.on('dong', value => { if (value.data === 'B:flush') resolve() }))
    service.ding('flush'); await bounded(flushed)
    assert.equal(delivered.filter(value => value === 'target-buffered').length, 1)
    t.pass('replayed buffer duplicates cannot double-deliver a business event')
  } finally { await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})

test('recovery candidate cannot publish without a valid same-account replay barrier', async t => {
  const a = await endpoint('A'); const b = await endpoint('B', 'account', true); const service = await running(a.address, true)
  try {
    await bounded(service.messageSendText('peer', 'ready-A'))
    const refreshing = replace(service, b.address)
    const rejected = assert.rejects(refreshing, /barrier/)
    const stream = await bounded(b.connected)
    stream.write(event(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }))
    stream.write(event(puppet.EventType.EVENT_TYPE_READY, {}))
    stream.write(event(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'other-account', throughSeq: 0 }))
    await bounded(rejected)
    assert.equal(service.options.endpoint, a.address)
    t.pass('candidate controls are validated before a transport acknowledgement')
  } finally { await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})

test('a UUID FileBox minted on A is refused after publication instead of resolving on B', async t => {
  const a = await endpoint('A'); const b = await endpoint('B'); const service = await running(a.address)
  try {
    const OldBox = Reflect.get(service, 'FileBoxUuid') as { fromUuid: (uuid: string, name: string) => { toStream: () => Promise<unknown>, type: number } }
    const minted = OldBox.fromUuid('uuid-from-A', 'a.jpg')
    await bounded(replace(service, b.address))
    assert.equal(service.options.endpoint, b.address)
    await assert.rejects(minted.toStream(), /replaced transport/)
    const serialize = Reflect.get(service, 'serializeFileBox') as (box: unknown) => Promise<string>
    await assert.rejects(serialize.call(service, minted), /replaced transport/)
    const NewBox = Reflect.get(service, 'FileBoxUuid') as typeof OldBox
    assert.notEqual(NewBox, OldBox)
    t.pass('server-local UUIDs stay bound to the transport that issued them')
  } finally { await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})

test('after publication, an ended B stream is recovered by the normal SDK path on B', async t => {
  const a = await endpoint('A'); const b = await endpoint('B'); const service = await running(a.address, true)
  try {
    await bounded(replace(service, b.address))
    const published = service.manager!
    const cursors = b.state.cursors.length
    published.emit('end')
    assert.equal(service.recoveryState.status, 'recovering')
    await waitUntil(() => b.state.cursors.length !== cursors && service.recoveryState.status === 'ready', 'B recovery stream ready')
    assert.equal(service.manager, published)
    assert.equal(a.state.cursors.length, 1)
    t.pass('the replacement transport owns the existing recovery path')
  } finally { await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})

test('a reset requested during replacement is ignored and does not reconnect A', async t => {
  const a = await endpoint('A'); const b = await endpoint('B', 'account', true); const service = await running(a.address)
  try {
    const refreshing = replace(service, b.address)
    const stream = await bounded(b.connected)
    const cursors = a.state.cursors.length
    await service.reset()
    b.ready(stream)
    await bounded(refreshing)
    assert.equal(a.state.cursors.length, cursors)
    assert.equal(service.options.endpoint, b.address)
    t.pass('reset is owned by the pending replacement')
  } finally { await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})

for (const candidate of [ false, true ]) {
  test(`old stream lost before sealing is recovered after the candidate fails (candidate=${candidate})`, async t => {
    const a = await endpoint('A'); const b = await endpoint('B', 'account', true)
    const service = new RefreshService({ token: `insecure_${randomUUID()}`, endpoint: a.address, tls: { disable: true }, recovery: { enabled: true, inactivityMilliseconds: 200 } })
    sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
    service.on('error', (): void => {})
    const loggedIn = new Promise<void>(resolve => service.once('login', (): void => { resolve() }))
    try {
      await bounded(service.onStart()); await bounded(loggedIn)
      let refreshing: Promise<void> | undefined
      if (candidate) {
        refreshing = replace(service, b.address); void refreshing.catch(() => undefined)
        await bounded(b.connected)
      }
      const stream = await bounded(a.connected); stream.end()
      await new Promise(resolve => setTimeout(resolve, 350))
      if (candidate) {
        const target = await bounded(b.connected)
        target.write(event(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'different-account' }))
        await assert.rejects(refreshing!, /account/)
      }
      await waitUntil(() => a.state.cursors.length >= 2 && service.recoveryState.status === 'ready', 'A recovery stream ready', 4000, 20)
      assert.equal(service.options.endpoint, a.address)
      assert.equal(b.state.starts + b.state.stops, 0)
      t.pass('the original transport keeps its normal recovery duty')
    } finally { await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
  })
}

test('a cursor still owed to the old endpoint is never written after publishing the new one', async t => {
  const a = await endpoint('A'); const b = await endpoint('B'); const service = await running(a.address)
  Object.defineProperty(service, 'eventWriteRetryDelays', { value: [] })
  const metadata = service.store.miscellaneous!
  const original = metadata.set.bind(metadata)
  let down = false
  const set = sinon.stub(metadata, 'set').callsFake(async (key, value): ReturnType<typeof original> => {
    if (down && key === 'lastEventSeq') { throw new Error('store down') }
    return original(key as string, value as string)
  })
  try {
    const stream = await bounded(a.connected)
    service.once('dong', (): never => { throw new Error('listener failed') })
    down = true
    const skipped = new Promise<void>(resolve => service.once('error', (): void => { resolve() }))
    stream.write(event(puppet.EventType.EVENT_TYPE_DONG, { data: 'old' }, 100))
    await bounded(skipped)
    down = false
    await replace(service, b.address)
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.equal(await metadata.get('lastEventSeq'), '0', 'the old server sequence is not carried to the new one')
    assert.ok(set.called)
    t.pass('owed cursors are scoped to the server that numbered them')
  } finally { await service.cleanup(); a.server.forceShutdown(); b.server.forceShutdown(); sinon.restore() }
})
