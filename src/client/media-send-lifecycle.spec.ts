import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'

import { grpc, puppet, StringValue } from '@juzi/wechaty-grpc'
import { FileBox } from 'file-box'
import { test, sinon } from 'tstest'

import { GrpcManager } from './grpc-manager.js'
import { PuppetService } from './puppet-service.js'

const UPLOAD_ID = '12345678-1234-4234-8234-123456789abc'
type Callback<T> = (error: Error | null, response?: T) => void
type Mode = 'single' | 'batch'

function deferred<T> () {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => { release = resolve })
  return { promise, resolve: release }
}

function observe<T> (promise: Promise<T>) {
  const result: { state: 'pending' | 'fulfilled' | 'rejected', value?: T, error?: unknown } = { state: 'pending' }
  void promise.then(value => { result.state = 'fulfilled'; result.value = value; return undefined }, error => { result.state = 'rejected'; result.error = error; return undefined })
  return result
}

// Only the transport boundary is fake. Both public methods, FileBox normalization,
// UUID upload helper, onStart/onStop and GrpcManager.stop/destroyClient are real.
class Upload extends Writable {

  readonly chunks: puppet.UploadRequest[] = []
  readonly wire: Buffer[] = []
  readonly cancel = sinon.spy((): void => {})
  readonly piped = sinon.spy()

  constructor (readonly callback: Callback<puppet.UploadResponse>, autoReply: boolean) {
    super({ objectMode: true })
    this.on('pipe', this.piped)
    this.on('finish', (): void => { if (autoReply) { this.reply() } })
  }

  override _write (chunk: puppet.UploadRequest, _encoding: string, callback: (error?: Error) => void): void {
    this.chunks.push(chunk)
    try {
      // Exercise the actual protobuf wire contract: string bytes fields are
      // interpreted as base64, so inspecting the pre-serialization value is insufficient.
      const decoded = puppet.UploadRequest.deserializeBinary(chunk.serializeBinary())
      this.wire.push(Buffer.from(decoded.getChunk_asU8()))
      callback()
    } catch (error) { callback(error as Error) }
  }

  reply (error: Error | null = null): void {
    const response = new puppet.UploadResponse()
    response.setId(UPLOAD_ID)
    this.callback(error, response)
  }

}

class Client {

  readonly uploads: Upload[] = []
  readonly sends: Array<puppet.MessageSendFileRequest | puppet.MessageBatchSendFileRequest> = []
  readonly close = sinon.spy()
  readonly start = sinon.spy((_request: unknown, _metadata: unknown, _options: unknown, callback: Callback<unknown>) => {
    callback(null)
    return { cancel: (): void => {} }
  })

  readonly stop = sinon.spy((_request: unknown, _metadata: unknown, _options: unknown, callback: Callback<unknown>) => {
    callback(null)
    return { cancel: (): void => {} }
  })

  autoReply = true
  sendError?: Error
  messageId = 'message-1'
  deprecatedId?: string

  upload (callback: Callback<puppet.UploadResponse>): Upload {
    const upload = new Upload(callback, this.autoReply)
    this.uploads.push(upload)
    return upload
  }

  messageSendFile (request: puppet.MessageSendFileRequest, callback: Callback<puppet.MessageSendFileResponse>): void {
    this.sends.push(request)
    const response = new puppet.MessageSendFileResponse()
    response.setId(this.messageId)
    if (this.deprecatedId) {
      const value = new StringValue()
      value.setValue(this.deprecatedId)
      response.setIdStringValueDeprecated(value)
    }
    callback(this.sendError ?? null, response)
  }

  messageBatchSendFile (request: puppet.MessageBatchSendFileRequest, callback: Callback<puppet.MessageBatchSendFileResponse>): void {
    this.sends.push(request)
    const response = new puppet.MessageBatchSendFileResponse()
    response.setResultsList(request.getConversationIdsList().map(id => {
      const result = new puppet.MessageBatchSendFileResponse.Result()
      result.setConversationId(id)
      if (id === 'failed') { result.setError('recipient unavailable') } else { result.setId(this.messageId) }
      return result
    }))
    callback(this.sendError ?? null, response)
  }

}

class MediaService extends PuppetService {

  get attachedManager (): GrpcManager | undefined { return this._grpcManager }
  async destroyStore (): Promise<void> { await this._payloadStore.destroy() }

}

async function fixture () {
  const clients: Client[] = []
  sinon.stub(GrpcManager.prototype as unknown as { initClient(): Promise<void> }, 'initClient').callsFake(async function (this: { _client: puppet.PuppetClient }): Promise<void> {
    const client = new Client()
    clients.push(client)
    this._client = client as unknown as puppet.PuppetClient
  })
  sinon.stub(GrpcManager.prototype, 'startStream').resolves()
  const service = new MediaService({ token: `insecure_${randomUUID()}` })
  service.on('error', (): void => {})
  await service.onStart()
  const clock = sinon.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout' ] })
  return {
    service,
    clients,
    clock,
    async cleanup (): Promise<void> {
      for (const client of clients) {
        for (const upload of client.uploads) { upload.reply(new Error('fixture cleanup')) }
      }
      await clock.tickAsync(1100)
      await service.onStop()
      await service.destroyStore()
      sinon.restore()
    },
  }
}

async function send (service: MediaService, mode: Mode, file: FileBox) {
  return mode === 'single'
    ? service.messageSendFile('recipient', file)
    : service.messageBatchSendFile([ 'recipient', 'failed' ], file, 'task-123')
}

for (const mode of [ 'single', 'batch' ] as const) {
  for (const error of [ null, new Error('synchronous upload failure') ]) {
    test(`${mode}: synchronous upload ${error ? 'failure' : 'success'} does not write or schedule a pipe`, async t => {
      const f = await fixture()
      const source = Readable.from([ Buffer.from('not consumed') ])
      const pipe = sinon.spy(source, 'pipe')
      try {
        const client = f.clients[0]!
        sinon.stub(client, 'upload').callsFake(callback => {
          const request = new Upload(callback, false)
          client.uploads.push(request)
          request.reply(error)
          return request
        })
        const timersBefore = f.clock.countTimers()
        const result = observe(send(f.service, mode, FileBox.fromStream(source, 'sync.txt')))
        await f.clock.tickAsync(0)
        assert.equal(result.state, error ? 'rejected' : 'fulfilled')
        if (error) { assert.equal(result.error, error) }
        assert.equal(client.uploads[0]!.chunks.length, 0, 'no header write after the callback has settled')
        assert.equal(f.clock.countTimers(), timersBefore, 'no delayed pipe timer is installed')
        await f.clock.tickAsync(1000)
        assert.equal(pipe.callCount, 0)
        assert.equal(source.destroyed, false, 'borrowed source is preserved')
        assert.equal(client.sends.length, error ? 0 : 1)
        t.pass('synchronous completion retains the early return')
      } finally { source.destroy(); await f.cleanup() }
    })
  }

  for (const sample of [
    { name: 'ASCII string chunks', stream: (): Readable => Readable.from([ 'hel', 'lo' ]), expected: Buffer.from('hello') },
    { name: 'base64-looking string chunk', stream: (): Readable => Readable.from([ 'YWJj' ]), expected: Buffer.from('YWJj') },
    { name: 'Unicode string chunks', stream: (): Readable => Readable.from([ '你', '好，SDK 👋' ]), expected: Buffer.from('你好，SDK 👋') },
    { name: 'UTF-8 encoded file stream', stream: (): Readable => createReadStream(new URL(import.meta.url), { encoding: 'utf8', highWaterMark: 127 }), expected: readFileSync(new URL(import.meta.url)) },
    { name: 'binary Buffer chunks', stream: (): Readable => Readable.from([ Buffer.from([ 0, 255, 254, 195, 40 ]), Buffer.from('YWJj') ]), expected: Buffer.concat([ Buffer.from([ 0, 255, 254, 195, 40 ]), Buffer.from('YWJj') ]) },
  ]) {
    test(`${mode}: protobuf upload preserves bytes for ${sample.name}`, async t => {
      const f = await fixture()
      const source = sample.stream()
      try {
        const operation = send(f.service, mode, FileBox.fromStream(source, 'wire.txt'))
        const result = observe(operation)
        const settled = Promise.allSettled([ operation ])
        await f.clock.tickAsync(1000)
        await settled
        assert.equal(result.state, 'fulfilled', String(result.error ?? 'send succeeds'))
        const client = f.clients[0]!
        assert.equal(client.uploads.length, 1)
        const bytes = Buffer.concat(client.uploads[0]!.wire)
        assert.deepEqual(bytes, sample.expected, 'decoded protobuf wire bytes match the original file bytes')
        assert.equal(client.sends.length, 1)
        t.pass('both upload content and send count match')
      } finally { source.destroy(); await f.cleanup() }
    })
  }

  for (const restart of [ false, true ]) {
    test(`${mode}: pending toStream cannot upload/send after stop${restart ? ' and start' : ''}`, async t => {
      const f = await fixture()
      const stream = Readable.from([ Buffer.from('media') ])
      const reading = deferred<Readable>()
      const file = FileBox.fromBuffer(Buffer.from('media'), 'media.txt')
      const toStream = sinon.stub(file, 'toStream').returns(reading.promise)
      try {
        const result = observe(send(f.service, mode, file))
        assert.equal(toStream.callCount, 1)
        const stopping = f.service.onStop()
        assert.equal(f.service.attachedManager, undefined, 'stop revokes ownership before its first await')
        await stopping
        assert.equal(f.clients[0]!.close.callCount, 1, 'stop closes without waiting for the file')
        if (restart) { await f.service.onStart() }
        reading.resolve(stream)
        await f.clock.tickAsync(1000)
        t.comment(JSON.stringify({ state: result.state, clients: f.clients.map(client => ({ uploads: client.uploads.length, sends: client.sends.length, closed: client.close.callCount })) }))
        assert.equal(result.state, 'rejected', 'the old media call must reject')
        assert.equal(f.clients.reduce((count, client) => count + client.uploads.length, 0), 0, 'neither client receives a late upload')
        assert.equal(f.clients.reduce((count, client) => count + client.sends.length, 0), 0, 'neither client receives a late send')
        if (restart) { assert.equal(f.clients[1]!.close.callCount, 0, 'the new client remains usable') }
        t.pass('old file work cannot escape into a subsequent run')
      } finally { reading.resolve(stream); await f.cleanup() }
    })
  }

  test(`${mode}: completed upload callback cannot send after stop/start`, async t => {
    const f = await fixture()
    try {
      const old = f.clients[0]!
      old.autoReply = false
      const result = observe(send(f.service, mode, FileBox.fromBuffer(Buffer.from('media'), 'media.txt')))
      await f.clock.tickAsync(1000)
      assert.equal(old.uploads.length, 1)
      assert.equal(old.uploads[0]!.writableFinished, true, 'the old upload body has completed')
      await f.service.onStop()
      assert.equal(old.close.callCount, 1)
      await f.service.onStart()
      old.uploads[0]!.reply()
      await f.clock.tickAsync(0)
      t.comment(JSON.stringify({ state: result.state, clients: f.clients.map(client => ({ uploads: client.uploads.length, sends: client.sends.length, closed: client.close.callCount })) }))
      assert.equal(result.state, 'rejected', 'late success does not authorize send')
      assert.equal(old.sends.length, 0)
      assert.equal(f.clients[1]!.sends.length, 0, 'an old UUID must not be sent on the new client')
      assert.equal(f.clients[1]!.uploads.length, 0, 'no automatic re-upload')
      t.pass('upload and send cannot straddle runs')
    } finally { await f.cleanup() }
  })

  test(`${mode}: cancelled delayed pipe settles and does not disturb a concurrent new call`, async t => {
    const f = await fixture()
    const input = Readable.from([ Buffer.from('old media') ])
    const foreignListener = sinon.spy()
    input.on('error', foreignListener)
    try {
      const old = f.clients[0]!
      old.autoReply = false
      const result = observe(send(f.service, mode, FileBox.fromStream(input, 'old.txt')))
      await f.clock.tickAsync(0)
      assert.equal(old.uploads.length, 1)
      assert.equal(old.uploads[0]!.piped.callCount, 0)
      await f.service.onStop()
      assert.equal(old.close.callCount, 1)
      await f.service.onStart()
      const current = observe(send(f.service, mode, FileBox.fromBuffer(Buffer.from('new media'), 'new.txt')))
      await f.clock.tickAsync(1000)
      t.comment(JSON.stringify({ state: result.state, current: current.state, oldBodyPipes: old.uploads[0]!.piped.callCount, oldChunks: old.uploads[0]!.chunks.length }))
      assert.equal(result.state, 'rejected', 'cancellation must settle even without an upload callback')
      assert.equal(old.uploads[0]!.piped.callCount, 0, 'no delayed body pipe after stop')
      assert.equal(old.uploads[0]!.cancel.callCount, 1, 'only the old upload is cancelled')
      assert.equal(old.uploads[0]!.chunks.length, 1, 'old upload keeps only its initial header')
      assert.equal(current.state, 'fulfilled')
      assert.equal(f.clients[1]!.uploads[0]!.cancel.callCount, 0)
      assert.equal(f.clients[1]!.sends.length, 1)
      assert.ok(input.listeners('error').includes(foreignListener), 'caller listeners are preserved')
      assert.equal(input.destroyed, false, 'the caller stream is not destroyed')
      const reading = observe(FileBox.fromStream(input, 'retained.txt').toBuffer())
      await f.clock.tickAsync(0)
      assert.equal(reading.value?.toString(), 'old media', 'the cancelled helper did not consume caller bytes')
      t.pass('cleanup is bounded to the cancelled call')
    } finally { await f.cleanup() }
  })

  test(`${mode}: slow reading/upload still succeeds once on the original client`, async t => {
    const f = await fixture()
    const reading = deferred<Readable>()
    const input = Readable.from([ Buffer.from('slow media') ])
    const file = FileBox.fromBuffer(Buffer.from('slow media'), 'slow.txt')
    sinon.stub(file, 'toStream').returns(reading.promise)
    try {
      const client = f.clients[0]!
      client.autoReply = false
      const result = observe(send(f.service, mode, file))
      await f.clock.tickAsync(30_000)
      assert.equal(result.state, 'pending', 'no new file-reading deadline')
      reading.resolve(input)
      await f.clock.tickAsync(31_000)
      assert.equal(result.state, 'pending', 'no new upload deadline')
      client.uploads[0]!.reply()
      await f.clock.tickAsync(0)
      assert.equal(result.state, 'fulfilled')
      assert.equal(client.uploads.length, 1)
      assert.equal(Buffer.concat(client.uploads[0]!.chunks.map(chunk => Buffer.from(chunk.getChunk_asU8()))).toString(), 'slow media')
      assert.equal(client.sends.length, 1)
      assert.equal(JSON.parse(client.sends[0]!.getFileBox()).uuid, UPLOAD_ID)
      if (mode === 'single') {
        assert.equal(result.value, 'message-1')
      } else {
        assert.deepEqual(result.value, { results: [ { conversationId: 'recipient', id: 'message-1', error: undefined }, { conversationId: 'failed', id: undefined, error: 'recipient unavailable' } ] })
        assert.equal((client.sends[0] as puppet.MessageBatchSendFileRequest).getBatchTaskId(), 'task-123')
      }
      t.pass('slow successful calls retain their result and client binding')
    } finally { reading.resolve(input); await f.cleanup() }
  })

  test(`${mode}: URL/QRCode/UUID passthrough and Buffer/File/Stream uploads remain compatible`, async t => {
    const f = await fixture()
    try {
      const client = f.clients[0]!
      for (const file of [ FileBox.fromUrl('https://example.com/media.png'), FileBox.fromQRCode('qr'), FileBox.fromUuid(UPLOAD_ID) ]) {
        const result = observe(send(f.service, mode, file))
        await f.clock.tickAsync(0)
        assert.equal(result.state, 'fulfilled')
        assert.deepEqual(JSON.parse(client.sends[client.sends.length - 1]!.getFileBox()), JSON.parse(JSON.stringify(file)))
      }
      assert.equal(client.uploads.length, 0)
      for (const file of [ FileBox.fromBuffer(Buffer.alloc(16 * 1024), 'small.txt'), FileBox.fromBuffer(Buffer.alloc(32 * 1024), 'large.txt'), FileBox.fromFile('tests/fixtures/smoke-testing.ts'), FileBox.fromStream(Readable.from([ 'stream' ]), 'stream.txt') ]) {
        const result = observe(send(f.service, mode, file))
        // FileBox.fromFile performs real fs.stat/open before creating the upload.
        await new Promise<void>(resolve => setImmediate(resolve))
        for (let attempt = 0; attempt < 20 && result.state === 'pending'; attempt++) { await f.clock.tickAsync(1000) }
        assert.equal(result.state, 'fulfilled')
      }
      assert.equal(client.uploads.length, 4)
      assert.equal(client.sends.length, 7)
      t.pass('type and 20KB policy are unchanged')
    } finally { await f.cleanup() }
  })

  test(`${mode}: upload/send failures preserve the original error and never retry`, async t => {
    const f = await fixture()
    try {
      const client = f.clients[0]!
      client.autoReply = false
      const uploadError = new Error('upload rejected')
      const uploading = observe(send(f.service, mode, FileBox.fromBuffer(Buffer.from('data'), 'file.txt')))
      await f.clock.tickAsync(1000)
      client.uploads[0]!.reply(uploadError)
      await f.clock.tickAsync(0)
      assert.equal(uploading.error, uploadError)
      assert.equal(client.sends.length, 0)
      const sendError = new Error('send response lost')
      client.sendError = sendError
      const sending = observe(send(f.service, mode, FileBox.fromUuid(UPLOAD_ID)))
      await f.clock.tickAsync(5000)
      assert.equal(sending.error, sendError)
      assert.equal(client.uploads.length, 1)
      assert.equal(client.sends.length, 1)
      t.pass('original errors are returned without resending')
    } finally { await f.cleanup() }
  })

  test(`${mode}: read failure and stream failure settle without affecting another upload`, async t => {
    const f = await fixture()
    try {
      const readError = new Error('file read failed')
      const file = FileBox.fromBuffer(Buffer.from('data'), 'bad.txt')
      sinon.stub(file, 'toStream').rejects(readError)
      const reading = observe(send(f.service, mode, file))
      await f.clock.tickAsync(0)
      assert.equal(reading.error, readError)
      assert.equal(f.clients[0]!.uploads.length, 0)
      const source = new Readable({ read (): void {} })
      const foreignListener = sinon.spy()
      source.on('error', foreignListener)
      const failed = observe(send(f.service, mode, FileBox.fromStream(source, 'bad-stream.txt')))
      const normal = observe(send(f.service, mode, FileBox.fromBuffer(Buffer.from('ok'), 'ok.txt')))
      await f.clock.tickAsync(1000)
      const streamError = new Error('source failed')
      source.emit('error', streamError)
      await f.clock.tickAsync(0)
      assert.equal(failed.error, streamError)
      assert.equal(normal.state, 'fulfilled')
      assert.equal(f.clients[0]!.uploads[0]!.cancel.callCount, 1)
      assert.equal(f.clients[0]!.uploads[1]!.cancel.callCount, 0)
      assert.deepEqual(source.listeners('error'), [ foreignListener ], 'only this operation removes its listener')
      source.destroy()
      t.pass('local stream failures retain their error and clean up only their own pipe')
    } finally { await f.cleanup() }
  })

  test(`${mode}: upload callback before delayed pipe clears only its own timer`, async t => {
    const f = await fixture()
    try {
      const client = f.clients[0]!
      client.autoReply = false
      const early = observe(send(f.service, mode, FileBox.fromBuffer(Buffer.from('early'), 'early.txt')))
      const normal = observe(send(f.service, mode, FileBox.fromBuffer(Buffer.from('normal'), 'normal.txt')))
      await f.clock.tickAsync(0)
      const error = new Error('upload declined before body')
      client.uploads[0]!.reply(error)
      await f.clock.tickAsync(1000)
      assert.equal(early.error, error)
      assert.equal(client.uploads[0]!.piped.callCount, 0)
      assert.equal(client.uploads[1]!.piped.callCount, 1)
      client.uploads[1]!.reply()
      await f.clock.tickAsync(0)
      assert.equal(normal.state, 'fulfilled')
      assert.equal(client.sends.length, 1)
      t.pass('a settled upload cannot pipe later or cancel a sibling timer')
    } finally { await f.cleanup() }
  })

  test(`${mode}: an early successful upload closes its owned file stream without a late pipe`, async t => {
    const f = await fixture()
    try {
      const file = FileBox.fromFile('tests/fixtures/smoke-testing.ts')
      const reading = sinon.spy(file, 'toStream')
      const result = observe(send(f.service, mode, file))
      const stream = await reading.firstCall.returnValue
      await f.clock.tickAsync(0)
      f.clients[0]!.uploads[0]!.reply()
      await f.clock.tickAsync(1000)
      assert.equal(result.state, 'fulfilled')
      assert.equal(stream.destroyed, true, 'a successful early callback cannot leak an unread file descriptor')
      assert.equal(f.clients[0]!.uploads[0]!.piped.callCount, 0)
      assert.equal(f.clients[0]!.sends.length, 1)
      t.pass('file resources are released on early success as well as failure')
    } finally { await f.cleanup() }
  })
}

test('single: empty and deprecated message IDs preserve their existing return values', async t => {
  const f = await fixture()
  try {
    const client = f.clients[0]!
    client.messageId = ''
    assert.equal(await f.service.messageSendFile('recipient', FileBox.fromUuid(UPLOAD_ID)), undefined)
    client.deprecatedId = 'legacy-id'
    assert.equal(await f.service.messageSendFile('recipient', FileBox.fromUuid(UPLOAD_ID)), 'legacy-id')
    t.pass('both legacy response branches are unchanged')
  } finally { await f.cleanup() }
})

test('real gRPC: stop closes a pending upload and the next run sends its complete media once', async t => {
  const server = new grpc.Server()
  const accepted = deferred<void>()
  const uploads: Buffer[][] = []
  let sends = 0
  server.addService(puppet.PuppetService, {
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      const event = new puppet.EventResponse()
      event.setType(puppet.EventType.EVENT_TYPE_HEARTBEAT)
      event.setPayload('{}')
      call.write(event)
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { callback(null, new puppet.StartResponse()) },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
    upload: (call: grpc.ServerReadableStream<puppet.UploadRequest, puppet.UploadResponse>, callback: grpc.sendUnaryData<puppet.UploadResponse>): void => {
      const chunks: Buffer[] = []
      uploads.push(chunks)
      call.on('data', (request: puppet.UploadRequest): void => { chunks.push(Buffer.from(request.getChunk_asU8())); accepted.resolve() })
      call.on('end', (): void => {
        const response = new puppet.UploadResponse()
        response.setId(UPLOAD_ID)
        callback(null, response)
      })
    },
    messageSendFile: (call: grpc.ServerUnaryCall<puppet.MessageSendFileRequest, puppet.MessageSendFileResponse>, callback: grpc.sendUnaryData<puppet.MessageSendFileResponse>): void => {
      assert.equal(JSON.parse(call.request.getFileBox()).uuid, UPLOAD_ID)
      sends++
      const response = new puppet.MessageSendFileResponse()
      response.setId('real-message')
      callback(null, response)
    },
  })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const service = new MediaService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true } })
  service.on('error', (): void => {})
  const source = new Readable({ read (): void {} })
  const pipe = sinon.spy(source, 'pipe')
  try {
    await service.onStart()
    const oldClient = service.grpcManager.client
    const close = sinon.spy(oldClient, 'close')
    const old = assert.rejects(service.messageSendFile('recipient', FileBox.fromStream(source, 'pending.txt')))
    await accepted.promise
    await service.onStop()
    assert.equal(close.callCount, 1, 'real client.close does not wait for the media stream')
    await old
    await service.onStart()
    assert.notEqual(service.grpcManager.client, oldClient)
    assert.equal(await service.messageSendFile('recipient', FileBox.fromBuffer(Buffer.from('complete media'), 'complete.txt')), 'real-message')
    assert.equal(sends, 1)
    assert.equal(pipe.callCount, 0, 'the cancelled delayed pipe never runs')
    assert.equal(Buffer.concat(uploads[0]!).length, 0)
    assert.equal(Buffer.concat(uploads[1]!).toString(), 'complete media')
    t.pass('actual client cancellation and the next upload both settle correctly')
  } finally { await service.onStop(); await service.destroyStore(); source.destroy(); server.forceShutdown(); sinon.restore() }
})
