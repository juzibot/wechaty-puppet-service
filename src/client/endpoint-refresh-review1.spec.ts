import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { FileBox } from 'file-box'
import * as PUPPET from '@juzi/wechaty-puppet'
import { sinon, test } from 'tstest'

import { PuppetService } from './puppet-service.js'

class RefreshService extends PuppetService {

  get store () { return this._payloadStore }
  get manager () { return this._grpcManager }
  async cleanup (): Promise<void> { await this.onStop(); await this.store.destroy() }

}

function deferred<T = void> () {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
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

async function drain (box: { toStream: () => Promise<NodeJS.ReadableStream> }): Promise<string | undefined> {
  try {
    const stream = await box.toStream()
    await bounded(new Promise<void>((resolve, reject) => { stream.on('error', reject); stream.on('end', () => resolve()); stream.resume() }))
    return undefined
  } catch (error) { return (error as Error).message }
}

function event (type: ReturnType<puppet.EventResponse['getType']>, payload: unknown, seq = 0): puppet.EventResponse {
  const response = new puppet.EventResponse()
  response.setType(type); response.setPayload(JSON.stringify(payload)); response.setSeq(seq)
  return response
}

type Held = { callback: grpc.sendUnaryData<puppet.MessageFileResponse>, id: string }

async function endpoint (name: string, holdReady = false) {
  const server = new grpc.Server()
  const connected = deferred<grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>>()
  const state = { sends: [] as string[], files: [] as string[], downloads: [] as string[], cursors: [] as number[], holdFile: false, holdUpload: false, holdText: false, uploads: 0, sentFiles: [] as string[], sentPosts: [] as string[], starts: 0, stops: 0, sendCursors: [] as number[], holdRecovery: undefined as undefined | ((stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>) => void) }
  const heldFile = deferred<Held>()
  const heldUpload = deferred<grpc.sendUnaryData<puppet.UploadResponse>>()
  const heldText = deferred<grpc.sendUnaryData<puppet.MessageSendTextResponse>>()
  let latest: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse> | undefined
  const ready = (stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
    stream.write(event(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'account' }))
    stream.write(event(puppet.EventType.EVENT_TYPE_READY, {}))
    stream.write(event(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'account', throughSeq: 0 }))
  }
  server.addService(puppet.PuppetService, {
    event: (stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      latest = stream; state.cursors.push(stream.request.getSeq()); connected.resolve(stream)
      stream.write(event(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}))
      if (state.holdRecovery && state.cursors.length > 1) { state.holdRecovery(stream); return }
      if (!holdReady) ready(stream)
    },
    start: (_call: unknown, callback: grpc.sendUnaryData<puppet.StartResponse>): void => { state.starts++; callback(null, new puppet.StartResponse()) },
    stop: (_call: unknown, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { state.stops++; callback(null, new puppet.StopResponse()) },
    messageSendText: (call: grpc.ServerUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>, callback: grpc.sendUnaryData<puppet.MessageSendTextResponse>): void => {
      state.sends.push(call.request.getText()); state.sendCursors.push(state.cursors.length)
      if (state.holdText) { heldText.resolve(callback); return }
      const response = new puppet.MessageSendTextResponse(); response.setId(name); callback(null, response)
    },
    messageFile: (call: grpc.ServerUnaryCall<puppet.MessageFileRequest, puppet.MessageFileResponse>, callback: grpc.sendUnaryData<puppet.MessageFileResponse>): void => {
      state.files.push(call.request.getId())
      if (state.holdFile) { heldFile.resolve({ callback, id: call.request.getId() }); return }
      const response = new puppet.MessageFileResponse()
      response.setFileBox(JSON.stringify(FileBox.fromUuid(`${name}-uuid`, 'f.jpg'))); callback(null, response)
    },
    upload: (call: grpc.ServerReadableStream<puppet.UploadRequest, puppet.UploadResponse>, callback: grpc.sendUnaryData<puppet.UploadResponse>): void => {
      call.on('data', (): void => {})
      call.on('end', (): void => {
        state.uploads++
        if (state.holdUpload) { heldUpload.resolve(callback); return }
        const response = new puppet.UploadResponse(); response.setId(`${name}-upload-uuid`); callback(null, response)
      })
    },
    messageSendFile: (call: grpc.ServerUnaryCall<puppet.MessageSendFileRequest, puppet.MessageSendFileResponse>, callback: grpc.sendUnaryData<puppet.MessageSendFileResponse>): void => {
      state.sentFiles.push(call.request.getFileBox())
      const response = new puppet.MessageSendFileResponse(); response.setId(`${name}-file`); callback(null, response)
    },
    messageSendPost: (call: grpc.ServerUnaryCall<puppet.MessageSendPostRequest, puppet.MessageSendPostResponse>, callback: grpc.sendUnaryData<puppet.MessageSendPostResponse>): void => {
      state.sentPosts.push(...(call.request.getContent()?.getSayableListList() ?? []).map((item: puppet.PostSayable) => item.getFileBox() || item.getText()))
      const response = new puppet.MessageSendPostResponse(); response.setId(`${name}-post`); callback(null, response)
    },
    download: (call: grpc.ServerWritableStream<puppet.DownloadRequest, puppet.DownloadResponse>): void => {
      state.downloads.push(call.request.getId()); call.end()
    },
  })
  const port = await bounded(new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  }))
  return { server, state, connected: connected.promise, heldFile: heldFile.promise, heldUpload: heldUpload.promise, heldText: heldText.promise, ready, latest: () => latest, address: `127.0.0.1:${port}` }
}

async function running (address: string, recovery = false): Promise<RefreshService> {
  const service = new RefreshService({ token: `insecure_${randomUUID()}`, endpoint: address, tls: { disable: true }, recovery: { enabled: recovery, inactivityMilliseconds: 45_000 } })
  try {
    sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
    service.on('error', (): void => {})
    const loggedIn = new Promise<void>(resolve => service.once('login', (): void => { resolve() }))
    await bounded(service.onStart()); await bounded(loggedIn)
    return service
  } catch (error) {
    // The creator owns cleanup until the service is handed to the caller.
    await service.cleanup().catch(() => undefined)
    throw error
  }
}

type Endpoint = Awaited<ReturnType<typeof endpoint>>
type Fixture = { a: Endpoint, b: Endpoint, service: RefreshService }

// Every resource is registered for teardown the moment it exists, so a failure at any step,
// including endpoint/service initialization, still closes the service and both servers.
async function withFixture (
  options: { holdB?: boolean, recovery?: boolean, keepService?: boolean },
  body: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  let a: Endpoint | undefined; let b: Endpoint | undefined; let service: RefreshService | undefined
  try {
    a = await endpoint('A')
    b = await endpoint('B', options.holdB ?? false)
    service = await running(a.address, options.recovery ?? false)
    await body({ a, b, service })
  } finally {
    try {
      if (service) { await (options.keepService ? service.store.destroy() : service.cleanup()).catch(() => undefined) }
    } finally {
      a?.server.forceShutdown(); b?.server.forceShutdown(); sinon.restore()
    }
  }
}

type Refresh = (endpoint: string, options: { deadline: number, beforePublish?: () => Promise<void> }) => Promise<void>
function replace (service: RefreshService, address: string, beforePublish?: () => Promise<void>): Promise<void> {
  const method = Reflect.get(service, 'replaceEndpoint') as Refresh
  return method.call(service, address, { deadline: Date.now() + 3000, beforePublish })
}

test('SDK M1: a business RPC queued during A recovery is not submitted to A after B is published', async t => {
  await withFixture({ holdB: true, recovery: true }, async ({ a, b, service }) => {
      // A's recovery stream reconnects but never reaches READY, so admission keeps the call queued.
      const recoveryStream = deferred<grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>>()
      const original = a.latest()!
      a.state.holdRecovery = recoveryStream.resolve
      await waitUntil(() => service.recoveryState.status === 'ready', 'startup gate ready')
      original.end()
      await waitUntil(() => service.recoveryState.status === 'recovering', 'A recovering')
      const queued = service.messageSendText('peer', 'queued-during-recovery')
      void queued.catch(() => undefined)
      t.comment(`at send: recovery=${service.recoveryState.status} A.cursors=${a.state.cursors.length}`)
      await bounded(recoveryStream.promise)
      t.comment(`recovery stream opened: recovery=${service.recoveryState.status} A.sends=${JSON.stringify(a.state.sends)} A.cursors=${a.state.cursors.length}`)
      t.comment(`A sends at cursor counts: ${JSON.stringify(a.state.sendCursors)}`)
      assert.equal(a.state.sends.length, 0, 'still queued before replacement')
      const refreshing = replace(service, b.address)
      b.ready(await bounded(b.connected))
      await bounded(refreshing)
      const outcome = await bounded(queued.then(id => ({ id }), (error: Error) => ({ error: error.message })))
      t.comment(`queued outcome: ${JSON.stringify(outcome)} A.sends=${JSON.stringify(a.state.sends)} B.sends=${JSON.stringify(b.state.sends)}`)
      assert.equal(a.state.sends.includes('queued-during-recovery'), false, 'the unsubmitted call must not reach A')
      assert.equal(await bounded(service.messageSendText('peer', 'after-publish')), 'B')
      t.pass('queued admission does not leak to the retired endpoint')
  })
})

test('SDK M1 control: an RPC already submitted to A before publication still completes', async t => {
  await withFixture({ holdB: true, recovery: true }, async ({ a, b, service }) => {
      a.state.holdFile = true
      const submitted = service.messageFile('msg-on-A')
      const held = await bounded(a.heldFile)
      const refreshing = replace(service, b.address)
      b.ready(await bounded(b.connected))
      await bounded(refreshing)
      const response = new puppet.MessageFileResponse()
      response.setFileBox(JSON.stringify(FileBox.fromUuid('A-uuid', 'f.jpg')))
      held.callback(null, response)
      const box = await bounded(submitted).catch((error: Error) => error)
      assert.equal(a.state.files.length, 1)
      assert.equal(b.state.files.length, 0)
      t.ok(!(box instanceof Error) || /replaced transport/.test(box.message), 'submitted A call settles (not stuck, not resent to B)')
  })
})

test('SDK M2: an A messageFile response that arrives after B is published never resolves on B', async t => {
  await withFixture({ holdB: true }, async ({ a, b, service }) => {
      a.state.holdFile = true
      const pending = service.messageFile('msg-on-A')
      const held = await bounded(a.heldFile)
      const refreshing = replace(service, b.address)
      b.ready(await bounded(b.connected))
      await bounded(refreshing)
      const response = new puppet.MessageFileResponse()
      response.setFileBox(JSON.stringify(FileBox.fromUuid('A-uuid', 'f.jpg')))
      held.callback(null, response)
      const box = await bounded(pending).catch((error: Error) => error)
      const downloadError = box instanceof Error ? box.message : await drain(box)
      t.comment(`late A box: ${box instanceof Error ? 'refused: ' + box.message : 'resolved'}; download error: ${downloadError}; A.downloads=${JSON.stringify(a.state.downloads)} B.downloads=${JSON.stringify(b.state.downloads)}`)
      assert.deepEqual(b.state.downloads, [], 'an A UUID must never be downloaded from B')
      t.pass('late A media responses keep A ownership or are refused')
  })
})

test('SDK M2 control: messageFile issued after publication resolves and downloads on B', async t => {
  await withFixture({  }, async ({ a, b, service }) => {
      await bounded(replace(service, b.address))
      const box = await bounded(service.messageFile('msg-on-B'))
      assert.equal(await drain(box), undefined)
      assert.deepEqual(b.state.downloads, [ 'B-uuid' ])
      assert.deepEqual(a.state.downloads, [])
      t.pass('normal media on the current endpoint is unaffected')
  })
})

test('SDK m1: rollback whose old-stream reconnect fails hands recovery back immediately', async t => {
  await withFixture({ recovery: true }, async ({ a, b, service }) => {
      const before = a.state.cursors.length
      const refreshing = replace(service, b.address, async (): Promise<void> => {
        // Final check refuses publication while A is unreachable, so the rollback reconnect fails.
        a.server.forceShutdown()
        throw new Error('final route check refused')
      })
      await assert.rejects(bounded(refreshing, 8000), /final route check refused|reconnect|Event stream|UNAVAILABLE|No connection/)
      // Default inactivity is 45 s; the normal error path reschedules in about 1 s.
      await waitUntil(() => service.recoveryState.status === 'recovering', 'recovery requested after failed rollback', 3000)
      t.comment(`A event subscriptions before/after: ${before}/${a.state.cursors.length}`)
      t.pass('rollback failure is handed to normal recovery without waiting for inactivity')
  })
})

test('SDK m1 control: a rollback whose old-stream reconnect succeeds stays ready on A', async t => {
  await withFixture({ recovery: true }, async ({ a, b, service }) => {
      const before = a.state.cursors.length
      await assert.rejects(bounded(replace(service, b.address, async (): Promise<void> => { throw new Error('final route check refused') })), /final route check refused/)
      await waitUntil(() => a.state.cursors.length > before, 'A stream reopened')
      assert.equal(service.options.endpoint, a.address)
      assert.equal(await bounded(service.messageSendText('peer', 'after-rollback')), 'A')
      t.pass('healthy rollback is unchanged')
  })
})

// Upload happens on A inside serializeFileBox; B is published before A answers with the UUID.
// The helper owns every fixture it creates and tears it down on success and failure alike.
async function uploadAcrossSwitch (
  send: (service: RefreshService) => Promise<unknown>,
  check: (fixture: { a: Endpoint, b: Endpoint, outcome: string }) => void,
): Promise<void> {
  await withFixture({ holdB: true }, async ({ a, b, service }) => {
    a.state.holdUpload = true
    const sending = send(service).then(() => 'sent', (error: Error) => `refused: ${error.message}`)
    // A send that fails before reaching the upload is a fixture error, not an upload-window RED.
    const early = await bounded(Promise.race([ a.heldUpload.then(() => undefined), sending ]), 6000)
    if (early !== undefined) { throw new assert.AssertionError({ message: `send settled before any upload on A: ${early}` }) }
    const answer = await a.heldUpload
    const refreshing = replace(service, b.address)
    b.ready(await bounded(b.connected))
    await bounded(refreshing)
    const response = new puppet.UploadResponse(); response.setId('A-upload-uuid'); answer(null, response)
    check({ a, b, outcome: await bounded(sending) })
  })
}

test('SDK M2 upload: a file uploaded on A across the switch is never sent to B (messageSendFile)', async t => {
  await uploadAcrossSwitch(svc => svc.messageSendFile('peer', FileBox.fromBase64(Buffer.from('payload').toString('base64'), 'f.txt')), ({ a, b, outcome }) => {
    t.comment(`outcome=${outcome} A.sentFiles=${JSON.stringify(a.state.sentFiles)} B.sentFiles=${JSON.stringify(b.state.sentFiles)}`)
    assert.equal(b.state.sentFiles.some(json => json.includes('A-upload-uuid')), false, 'B must not receive an A upload UUID')
  })
  t.pass('upload-to-send window is owned by the uploading transport')
})

test('SDK M2 upload: a post attachment uploaded on A across the switch is never sent to B (messageSendPost)', async t => {
  // Base64 is JSON-serializable (messageSendPost stringifies the payload first) yet is not passed through, so it is uploaded.
  const post = { type: 0, sayableList: [ { type: PUPPET.types.Sayable.Attachment, payload: { filebox: FileBox.fromBase64(Buffer.from('payload').toString('base64'), 'p.txt') } } ] } as unknown as PUPPET.payloads.PostClient
  await uploadAcrossSwitch(svc => svc.messageSendPost('peer', post), ({ a, b, outcome }) => {
    t.comment(`outcome=${outcome} A.sentPosts=${JSON.stringify(a.state.sentPosts)} B.sentPosts=${JSON.stringify(b.state.sentPosts)}`)
    assert.equal(b.state.sentPosts.some(json => json.includes('A-upload-uuid')), false, 'B must not receive an A upload UUID')
  })
  t.pass('postPayloadToPb serialization is owned by the uploading transport')
})

test('SDK M2 upload control: a URL FileBox has no server UUID and is still sent after the switch', async t => {
  await withFixture({  }, async ({ a, b, service }) => {
      await bounded(replace(service, b.address))
      assert.equal(await bounded(service.messageSendFile('peer', FileBox.fromUrl('https://example.invalid/a.jpg', { name: 'a.jpg' }))), 'B-file')
      assert.equal(b.state.uploads + a.state.uploads, 0)
      assert.equal(b.state.sentFiles.length, 1)
      t.pass('portable payloads are not refused')
  })
})

test('SDK M1 control: a text RPC already submitted to A keeps its A success across publication', async t => {
  await withFixture({ holdB: true, recovery: true }, async ({ a, b, service }) => {
      a.state.holdText = true
      const submitted = service.messageSendText('peer', 'submitted-on-A')
      const answer = await bounded(a.heldText)
      const refreshing = replace(service, b.address)
      b.ready(await bounded(b.connected))
      await bounded(refreshing)
      const response = new puppet.MessageSendTextResponse(); response.setId('A-ok'); answer(null, response)
      assert.equal(await bounded(submitted), 'A-ok')
      assert.deepEqual(a.state.sends, [ 'submitted-on-A' ])
      assert.deepEqual(b.state.sends, [])
      t.pass('submitted business RPC keeps its original callback')
  })
})

test('SDK M1 control: when the candidate fails, a call queued during A recovery completes on A once A recovers', async t => {
  await withFixture({ holdB: true, recovery: true }, async ({ a, b, service }) => {
      const recoveryStream = deferred<grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>>()
      a.state.holdRecovery = recoveryStream.resolve
      await waitUntil(() => service.recoveryState.status === 'ready', 'startup gate ready')
      a.latest()!.end()
      await waitUntil(() => service.recoveryState.status === 'recovering', 'A recovering')
      const held = await bounded(recoveryStream.promise)
      const queued = service.messageSendText('peer', 'queued-then-A')
      void queued.catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.deepEqual(a.state.sends, [], 'queued, not submitted')
      const refreshing = replace(service, b.address)
      const target = await bounded(b.connected)
      target.write(event(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'different-account' }))
      await assert.rejects(bounded(refreshing), /account/)
      a.ready(held)
      const outcome = await bounded(queued.then(id => ({ id }), (error: Error) => ({ error: error.message })))
      t.comment(`queued outcome after failed candidate: ${JSON.stringify(outcome)} A.sends=${JSON.stringify(a.state.sends)}`)
      assert.deepEqual(outcome, { id: 'A' })
      assert.deepEqual(b.state.sends, [])
      t.pass('a failed replacement leaves queued admission on A')
  })
})

test('SDK m1 control: an ordinary stop during the rollback reconnect does not restart A', async t => {
  await withFixture({ recovery: true, keepService: true }, async ({ a, b, service }) => {
      let stopping: Promise<void> | undefined
      const refreshing = replace(service, b.address, async (): Promise<void> => {
        stopping = service.onStop()
        throw new Error('final route check refused')
      })
      await assert.rejects(bounded(refreshing), /final route check refused|superseded/)
      await bounded(stopping!)
      const subscriptions = a.state.cursors.length
      await new Promise(resolve => setTimeout(resolve, 1500))
      assert.equal(a.state.cursors.length, subscriptions, 'no A resubscription after stop')
      assert.notEqual(service.recoveryState.status, 'recovering')
      t.pass('stop wins over rollback recovery')
  })
})

test('SDK m1 control: without recovery, a failed rollback reconnect keeps the original error and starts no background recovery', async t => {
  await withFixture({}, async ({ a, b, service }) => {
    const errors: unknown[] = []
    service.on('error', (error: unknown): void => { errors.push(error) })
    const refreshing = replace(service, b.address, async (): Promise<void> => {
      a.server.forceShutdown()
      throw new Error('final route check refused')
    })
    const rejection = await bounded(refreshing, 8000).then(() => 'resolved', (error: Error) => error.message)
    await new Promise(resolve => setTimeout(resolve, 1500))
    t.comment(`rejection: ${rejection}; errors emitted: ${errors.length}`)
    assert.match(rejection, /final route check refused/, 'the original beforePublish error is kept')
    assert.equal(service.recoveryState.status, 'disabled')
    assert.ok(errors.length <= 1, 'the rollback error is reported at most once')
    t.pass('non-recovery rollback failure uses the original error path only')
  })
})

// An existing UUID is not uploaded again, but it still belongs to the server that issued it.
// Holding the first attachment's upload opens the serialize→send window for the UUID that follows it.
test('SDK M2 UUID: an existing A UUID serialized before the switch is not sent to B (messageSendPost)', async t => {
  await withFixture({ holdB: true }, async ({ a, b, service }) => {
    const OldBox = Reflect.get(service, 'FileBoxUuid') as typeof FileBox
    const existing = OldBox.fromUuid('A-existing-uuid', 'e.jpg')
    a.state.holdUpload = true
    // The upload is the second attachment, so the existing UUID is already serialized when the switch happens.
    const post = { type: 0, sayableList: [
      { type: PUPPET.types.Sayable.Attachment, payload: { filebox: existing } },
      { type: PUPPET.types.Sayable.Attachment, payload: { filebox: FileBox.fromBase64(Buffer.from('payload').toString('base64'), 'p.txt') } },
    ] } as unknown as PUPPET.payloads.PostClient
    const sending = service.messageSendPost('peer', post).then(() => 'sent', (error: Error) => `refused: ${error.message}`)
    const early = await bounded(Promise.race([ a.heldUpload.then(() => undefined), sending ]), 6000)
    if (early !== undefined) { throw new assert.AssertionError({ message: `send settled before the upload: ${early}` }) }
    const answer = await a.heldUpload
    const refreshing = replace(service, b.address)
    b.ready(await bounded(b.connected))
    await bounded(refreshing)
    const response = new puppet.UploadResponse(); response.setId('A-upload-uuid'); answer(null, response)
    const outcome = await bounded(sending)
    t.comment(`outcome=${outcome} B.sentPosts=${JSON.stringify(b.state.sentPosts)}`)
    assert.equal(b.state.sentPosts.some(json => json.includes('A-existing-uuid') || json.includes('A-upload-uuid')), false, 'B must not receive any A-owned UUID')
  })
  t.pass('every server UUID in one request is owned by the transport it is sent on')
})

test('SDK M2 UUID control: an existing UUID of the current transport is still sent', async t => {
  await withFixture({}, async ({ b, service }) => {
    await bounded(replace(service, b.address))
    const CurrentBox = Reflect.get(service, 'FileBoxUuid') as typeof FileBox
    assert.equal(await bounded(service.messageSendFile('peer', CurrentBox.fromUuid('B-existing-uuid', 'e.jpg'))), 'B-file')
    assert.ok(b.state.sentFiles.some(json => json.includes('B-existing-uuid')))
  })
  t.pass('current-transport UUIDs are not refused')
})

// Focused check of the real per-request serializer state. There is no stable public entry that opens the
// single-file window between serializing an existing UUID and sending it (the pass-through has no I/O),
// so the guard itself is exercised by swapping the current FileBox class between serialize and assert,
// exactly what a publication does.
test('SDK M2 serializer: an existing UUID binds the request to its transport; URL/QRCode do not', async t => {
  await withFixture({}, async ({ service }) => {
    type Serializer = { serialize: (box: unknown) => Promise<string>, assertCurrent: () => void }
    const serializer = (): Serializer => (Reflect.get(service, 'fileBoxSerializer') as () => Serializer).call(service)
    const publish = (): void => {
      // Same class swap replaceEndpoint performs at publication.
      Reflect.set(service, 'FileBoxUuid', (Reflect.get(service, 'transportFileBox') as () => unknown).call(service))
    }
    const CurrentBox = Reflect.get(service, 'FileBoxUuid') as typeof FileBox

    const uuid = serializer()
    await uuid.serialize(CurrentBox.fromUuid('A-existing-uuid', 'e.jpg'))
    uuid.assertCurrent() // unchanged transport: passes
    publish()
    assert.throws(() => uuid.assertCurrent(), /replaced transport/, 'existing UUID serialized before the switch is refused')

    const portable = serializer()
    await portable.serialize(FileBox.fromUrl('https://example.invalid/a.jpg', { name: 'a.jpg' }))
    await portable.serialize(FileBox.fromQRCode('qr-text'))
    publish()
    assert.doesNotThrow(() => portable.assertCurrent(), 'URL/QRCode never bind the request')

    const NewBox = Reflect.get(service, 'FileBoxUuid') as typeof FileBox
    const fresh = serializer()
    await fresh.serialize(NewBox.fromUuid('B-existing-uuid', 'e.jpg'))
    assert.doesNotThrow(() => fresh.assertCurrent(), 'a UUID of the current transport is sent')
  })
  t.pass('request-level ownership covers uploaded and existing UUIDs and leaves portable boxes free')
})

