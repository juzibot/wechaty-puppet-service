import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { PuppetService } from './puppet-service.js'
import { GrpcManager } from './grpc-manager.js'

class RestartService extends PuppetService {

  protected override hookPayloadStore (): void {}
  override async login (_contactId: string): Promise<void> {}
  attach (manager: GrpcManager): void { this._grpcManager = manager; this.bridgeGrpcEventStream(manager) }
  get metadata () { return this._payloadStore.miscellaneous! }
  async cleanup (): Promise<void> { await this.onStop(); await this._payloadStore.destroy() }

}

function event (seq: number): puppet.EventResponse {
  const response = new puppet.EventResponse()
  response.setType(puppet.EventType.EVENT_TYPE_DONG)
  response.setPayload(JSON.stringify({ data: String(seq) }))
  response.setSeq(seq)
  return response
}

test('prepare drains accepted events and metadata, rejects new events and suppresses reconnect', async t => {
  const service = new RestartService({ token: randomUUID() })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  const stop = sinon.stub(manager, 'stopStream').callsFake((): void => { manager.emit('cancel'); manager.emit('error', new Error('cancelled')) })
  const close = sinon.stub(manager, 'stop').resolves()
  const received: string[] = []
  service.on('dong', ({ data }): void => { received.push(data!) })
  service.on('error', (): never => { throw new Error('Unexpected stream error') })
  service.attach(manager)
  try {
    manager.emit('data', event(1)); manager.emit('data', event(2))
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    manager.emit('data', event(3))
    await service.reset()
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.deepEqual(received, [ '1', '2' ])
    assert.equal(await service.metadata.get('lastEventSeq'), '2')
    assert.equal(stop.callCount, 1)
    assert.equal(close.callCount, 0)
    assert.equal(service.grpcManager, manager)
    t.pass('queued workers and client survive the intake fence')
  } finally { await service.cleanup(); sinon.restore() }
})

test('a checkpoint that keeps failing is retried and skipped without halting the stream', async t => {
  const service = new RestartService({ token: randomUUID() })
  Object.defineProperty(service, 'eventWriteRetryDelays', { value: [ 1, 1, 1 ] })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  const stop = sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  const set = sinon.stub(service.metadata, 'set').rejects(new Error('checkpoint write failed'))
  const errors: unknown[] = []
  const dongs: string[] = []
  service.on('error', (error): void => { errors.push(error) })
  service.on('dong', ({ data }): void => { dongs.push(String(data)) })
  service.attach(manager)
  try {
    manager.emit('data', event(1))
    manager.emit('data', event(2))
    // The cursor cannot be made durable, so handing over would replay delivered events.
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /checkpoint write failed/)
    assert.deepEqual(dongs, [ '1', '2' ], 'each listener runs once and later events still arrive')
    assert.ok(set.callCount >= 8, 'every event retried its checkpoint before skipping')
    assert.equal(errors.length, 2)
    assert.equal(stop.callCount, 1, 'only preparation stops the stream')
    t.pass('a skipped checkpoint never halts the stream; only a still-lagging cursor fails preparation')
  } finally { sinon.restore(); sinon.stub(manager, 'stop').resolves(); await service.cleanup(); sinon.restore() }
})

test('a transient checkpoint failure is retried in place without re-emitting', async t => {
  const service = new RestartService({ token: randomUUID() })
  Object.defineProperty(service, 'eventWriteRetryDelays', { value: [ 1, 1, 1 ] })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  const original = service.metadata.set.bind(service.metadata)
  let failures = 2
  sinon.stub(service.metadata, 'set').callsFake(async (key, value): ReturnType<typeof original> => {
    if (failures-- > 0) { throw new Error('transient') }
    return original(key as string, value as string)
  })
  let dongs = 0
  const errors = sinon.spy()
  service.on('dong', (): void => { dongs++ })
  service.on('error', errors)
  service.attach(manager)
  try {
    manager.emit('data', event(1))
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.equal(dongs, 1)
    assert.equal(errors.callCount, 0)
    assert.equal(await service.metadata.get('lastEventSeq'), '1')
    t.pass('retry covers the write only')
  } finally { sinon.restore(); sinon.stub(manager, 'stop').resolves(); await service.cleanup(); sinon.restore() }
})

test('each caller has an independent bounded deadline while the shared drain continues', async t => {
  const service = new RestartService({ token: randomUUID() })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  const stop = sinon.stub(manager, 'stopStream')
  sinon.stub(manager, 'stop').resolves()
  let release!: () => void
  const blocked = new Promise<void>((resolve): void => { release = resolve })
  const original = service.metadata.set.bind(service.metadata)
  sinon.stub(service.metadata, 'set').callsFake(async (key, value): ReturnType<typeof original> => { await blocked; return original(key, value) })
  service.attach(manager)
  try {
    manager.emit('data', event(1))
    const short = assert.rejects(service.prepareForRestart({ deadline: Date.now() + 20 }), /deadline/)
    const long = service.prepareForRestart({ deadline: Date.now() + 2000 })
    await short
    assert.equal(stop.callCount, 1)
    release()
    await long
    assert.equal(await service.metadata.get('lastEventSeq'), '1')
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() - 1 }), /deadline/)
    await assert.rejects(service.prepareForRestart({ deadline: Infinity }), /finite/)
    t.pass('timeout does not claim completion or cancel another caller')
  } finally { release(); await service.cleanup(); sinon.restore() }
})

test('listener failure skips only its event; stream close failure still fails preparation', async t => {
  for (const failure of [ 'listener', 'close' ]) {
    const service = new RestartService({ token: randomUUID() })
    const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
    const stop = sinon.stub(manager, 'stopStream')
    sinon.stub(manager, 'stop').resolves()
    if (failure === 'close') { stop.throws(new Error('close failed')) }
    let calls = 0
    service.on('dong', ({ data }): void => { calls++; if (data === '1') { throw new Error('listener failed') } })
    service.on('error', (): void => {})
    service.attach(manager)
    try {
      manager.emit('data', event(1))
      manager.emit('data', event(2))
      if (failure === 'listener') {
        await service.prepareForRestart({ deadline: Date.now() + 2000 })
        assert.equal(calls, 2, 'the failed event was not retried and the next one still ran')
        assert.equal(await service.metadata.get('lastEventSeq'), '2', 'the cursor moved past the skipped event')
      } else {
        await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /close/)
        await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /close/)
      }
    } finally { await service.cleanup(); sinon.restore() }
  }
  t.pass('event failures are skipped; transport close failure stays sticky')
})

test('preparing an offline recovery session fails explicitly without claiming a drain', async t => {
  const service = new RestartService({ token: randomUUID(), recovery: { enabled: true } })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  service.attach(manager)
  try {
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /during recovery/)
    await service.reset()
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /during recovery/)
    t.pass('non-ready recovery cannot be mistaken for drained')
  } finally { await service.cleanup(); sinon.restore() }
})

test('real RPC survives preparation and next start fences the previous manager', async t => {
  const previous = process.env['WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE']
  process.env['WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE'] = 'true'
  const server = new grpc.Server()
  let accepted!: () => void
  const acceptance = new Promise<void>((resolve): void => { accepted = resolve })
  let reply!: grpc.sendUnaryData<puppet.MessageSendTextResponse>
  server.addService(puppet.PuppetService, {
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
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
    messageSendText: (_call: grpc.ServerUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>, callback: grpc.sendUnaryData<puppet.MessageSendTextResponse>): void => { reply = callback; accepted() },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const service = new RestartService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: true } })
  const errors: unknown[] = []
  service.on('error', (error): void => { errors.push(error) })
  const waitReady = async (): Promise<void> => {
    const deadline = Date.now() + 2000
    while (service.recoveryState.status !== 'ready') {
      if (Date.now() >= deadline) { throw new Error('ready timeout') }
      await new Promise<void>((resolve): void => { setTimeout(resolve, 5) })
    }
  }
  try {
    await service.onStart(); await waitReady()
    const oldManager = service.grpcManager
    const sending = service.messageSendText('contact', 'accepted')
    await acceptance
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.equal(service.recoveryState.status, 'ready')
    const result = new puppet.MessageSendTextResponse(); result.setId('sent')
    reply(null, result)
    assert.equal(await sending, 'sent')
    assert.equal(await service.metadata.get('accountId'), 'account')
    await service.onStop(); await service.onStart(); await waitReady()
    oldManager.emit('data', event(99)); oldManager.emit('error', new Error('old stream')); oldManager.emit('cancel')
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.notEqual(await service.metadata.get('lastEventSeq'), '99')
    assert.deepEqual(errors, [])
    t.pass('real pending write completes, cursor survives disabled cache, restart succeeds')
  } finally {
    await service.cleanup(); server.forceShutdown()
    if (previous === undefined) { delete process.env['WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE'] } else { process.env['WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE'] = previous }
  }
})

test('preparation racing a connecting legacy stream rejects and cannot reopen it', async t => {
  const server = new grpc.Server()
  let connected!: () => void
  const connection = new Promise<void>((resolve): void => { connected = resolve })
  let starts = 0
  server.addService(puppet.PuppetService, {
    event: (): void => { connected() },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { starts++; callback(null, new puppet.StartResponse()) },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const service = new RestartService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true } })
  try {
    const starting = assert.rejects(service.onStart(), /closed|superseded|restart/)
    await connection
    const manager = service.grpcManager
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /during recovery/)
    await starting
    assert.equal(starts, 0)
    assert.equal(manager.eventStream, undefined)
    await assert.rejects(manager.startStream(), /disabled for restart/)
    assert.throws((): void => { void manager.client }, /NO CLIENT/)
    t.pass('pending startup cannot publish a late stream or start RPC')
  } finally { await service.cleanup(); server.forceShutdown() }
})

test('preparation commits a skipped event cursor that could not be written earlier', async t => {
  const service = new RestartService({ token: randomUUID() })
  Object.defineProperty(service, 'eventWriteRetryDelays', { value: [] })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  const original = service.metadata.set.bind(service.metadata)
  let down = true
  sinon.stub(service.metadata, 'set').callsFake(async (key, value): ReturnType<typeof original> => {
    if (down) { throw new Error('store down') }
    return original(key as string, value as string)
  })
  service.on('error', (): void => {})
  service.on('dong', (): never => { throw new Error('listener failed') })
  service.attach(manager)
  try {
    manager.emit('data', event(1))
    await new Promise<void>((resolve): void => { setTimeout(resolve, 20) })
    assert.equal(await service.metadata.get('lastEventSeq'), undefined)
    down = false
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.equal(await service.metadata.get('lastEventSeq'), '1', 'the next process does not replay it')
    t.pass('a lagging cursor is made durable before handing over')
  } finally { sinon.restore(); sinon.stub(manager, 'stop').resolves(); await service.cleanup(); sinon.restore() }
})

test('a store that stays down stops backing off after repeated exhausted writes', async t => {
  const service = new RestartService({ token: randomUUID() })
  Object.defineProperty(service, 'eventWriteRetryDelays', { value: [ 1, 1, 1 ] })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  const set = sinon.stub(service.metadata, 'set').rejects(new Error('store down'))
  service.on('error', (): void => {})
  service.attach(manager)
  try {
    for (let seq = 1; seq <= 5; seq++) { manager.emit('data', event(seq)) }
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /store down/)
    // 3 events x 4 attempts until the breaker opens, then 1 attempt each (plus skip commits).
    assert.ok(set.callCount < 5 * 4 * 2, `attempts were bounded: ${set.callCount}`)
    t.pass('a dead store cannot stall the stream behind retries')
  } finally { sinon.restore(); sinon.stub(manager, 'stop').resolves(); await service.cleanup(); sinon.restore() }
})
