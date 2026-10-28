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

test('prepare propagates checkpoint failure permanently', async t => {
  const service = new RestartService({ token: randomUUID() })
  const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
  sinon.stub(manager, 'stopStream'); sinon.stub(manager, 'stop').resolves()
  sinon.stub(service.metadata, 'set').rejects(new Error('checkpoint write failed'))
  service.attach(manager)
  try {
    manager.emit('data', event(1))
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /checkpoint write failed/)
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /checkpoint write failed/)
    t.pass('checkpoint failures cannot become successful preparation')
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

test('event listener failure and stream close failure remain failed', async t => {
  for (const failure of [ 'listener', 'close' ]) {
    const service = new RestartService({ token: randomUUID() })
    const manager = new GrpcManager({ token: `insecure_${randomUUID()}` })
    const stop = sinon.stub(manager, 'stopStream')
    sinon.stub(manager, 'stop').resolves()
    if (failure === 'close') { stop.throws(new Error('close failed')) }
    service.on('dong', (): never => { throw new Error('listener failed') })
    service.attach(manager)
    try {
      manager.emit('data', event(1))
      await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), new RegExp(failure))
      await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), new RegExp(failure))
    } finally { await service.cleanup(); sinon.restore() }
  }
  t.pass('failure is sticky across repeated callers')
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
    await assert.rejects(service.prepareForRestart({ deadline: Date.now() + 2000 }), /during recovery/)
    await starting
    assert.equal(starts, 0)
    assert.equal(service.grpcManager.eventStream, undefined)
    await assert.rejects(service.grpcManager.startStream(), /disabled for restart/)
    t.pass('pending startup cannot publish a late stream or start RPC')
  } finally { await service.cleanup(); server.forceShutdown() }
})
