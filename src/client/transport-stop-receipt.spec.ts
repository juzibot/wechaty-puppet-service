import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import type { GrpcManager } from './grpc-manager.js'
import { PuppetService } from './puppet-service.js'

class ReceiptService extends PuppetService {

  get store () { return this._payloadStore }
  get currentManager (): GrpcManager | undefined { return this._grpcManager }
  async cleanup (): Promise<void> { await this.onStop(); await this._payloadStore.destroy() }

}

interface Deferred { readonly promise: Promise<void>, readonly resolve: () => void }

function deferred (): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((_resolve): void => { resolve = _resolve })
  return { promise, resolve }
}

async function bounded<Result> (operation: Promise<Result>, milliseconds = 4000): Promise<Result> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([ operation, new Promise<never>((_resolve, reject): void => {
      timer = setTimeout((): void => { reject(new Error('test barrier timeout')) }, milliseconds)
    }) ])
  } finally { clearTimeout(timer) }
}

async function until (condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${label}`) }
    await new Promise<void>((resolve): void => { setTimeout(resolve, 5) })
  }
}

function response (type: ReturnType<puppet.EventResponse['getType']>, payload: unknown): puppet.EventResponse {
  const event = new puppet.EventResponse()
  event.setType(type); event.setPayload(JSON.stringify(payload)); event.setSeq(0)
  return event
}

/** Blocks stopService() between detaching the manager and stopping it, as a stuck checkpoint write does. */
function blockCheckpoints (service: ReceiptService): Deferred {
  const barrier = deferred()
  ;(service as unknown as { checkpointQueue: Promise<void> }).checkpointQueue = barrier.promise
  return barrier
}

function stoppingTask (service: ReceiptService): Promise<void> | undefined {
  return (service as unknown as { stoppingTask?: Promise<void> }).stoppingTask
}

interface Harness {
  readonly service: ReceiptService
  readonly manager: GrpcManager
  readonly stops: () => number
  readonly errors: unknown[]
  readonly close: () => Promise<void>
}

/** A started service on a loopback Work that counts the Stop RPCs it receives. */
async function startHarness (options: { failStop?: boolean, recoveryEnabled?: boolean } = {}): Promise<Harness> {
  const server = new grpc.Server()
  let stops = 0
  server.addService(puppet.PuppetService, {
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}))
      call.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      call.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
      call.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'A', throughSeq: 0 }))
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => {
      callback(null, new puppet.StartResponse())
    },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => {
      stops++
      if (options.failStop) {
        callback({ code: grpc.status.INTERNAL, details: 'stop refused' } as grpc.ServiceError)
        return
      }
      callback(null, new puppet.StopResponse())
    },
  })
  const port = await bounded(new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  }))
  const service = new ReceiptService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: options.recoveryEnabled ?? false } })
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  const errors: unknown[] = []
  service.on('error', (error): void => { errors.push(error) })
  try { await bounded(service.start()) } catch (error) { server.forceShutdown(); await service.cleanup(); throw error }
  const manager = service.currentManager
  if (!manager) { throw new Error('the service has no manager after start') }
  return {
    service,
    manager,
    stops: (): number => stops,
    errors,
    close: async (): Promise<void> => { server.forceShutdown(); await bounded(service.cleanup()) },
  }
}

for (const recoveryEnabled of [ false, true ]) {
  test(`receipt ignores error events read in the stop window (recovery ${recoveryEnabled})`, async t => {
    const harness = await startHarness({ recoveryEnabled })
    const barrier = blockCheckpoints(harness.service)
    try {
      const stopped = harness.service.stop()
      await bounded(until((): boolean => stoppingTask(harness.service) !== undefined && !harness.service.currentManager, 'stop window'))
      const receipt = harness.service.stopWithReceipt()
      const before = harness.errors.length
      assert.throws((): void => { void harness.service.grpcManager }, /no grpc manager/)
      assert.ok(harness.errors.length > before, 'the getter still reports a global error in the window')
      barrier.resolve()
      assert.deepEqual(await bounded(receipt), { released: true, serverAcked: true, forced: false })
      await bounded(stopped)
      assert.throws((): void => { void harness.manager.client }, /NO CLIENT/)
      assert.equal(harness.stops(), 1)
      t.pass('the receipt comes from the manager, not from global error events')
    } finally { barrier.resolve(); await harness.close(); sinon.restore() }
  })

  test(`timeout force-releases and the stalled stop never sends a late Stop (recovery ${recoveryEnabled})`, async t => {
    const harness = await startHarness({ recoveryEnabled })
    const barrier = blockCheckpoints(harness.service)
    try {
      const startedAt = Date.now()
      const receipt = await bounded(harness.service.stopWithReceipt({ timeoutMilliseconds: 50 }))
      assert.ok(Date.now() - startedAt < 1000, 'the receipt is bounded by the timeout')
      assert.equal(receipt.released, true)
      assert.equal(receipt.forced, true)
      assert.equal(receipt.serverAcked, false)
      assert.match(String(receipt.stopError?.message), /timed out/)
      assert.equal(receipt.releaseError, undefined)
      assert.throws((): void => { void harness.manager.client }, /NO CLIENT/)
      assert.equal(await bounded(harness.service.stopWithReceipt()), receipt, 'the terminal receipt is shared')
      const errorsBeforeResume = harness.errors.length
      barrier.resolve()
      await bounded(until((): boolean => stoppingTask(harness.service) === undefined, 'stalled stop to finish'))
      await new Promise<void>((resolve): void => { setTimeout(resolve, 50) })
      assert.equal(harness.stops(), 0, 'a force-released manager never sends Stop')
      assert.equal(harness.errors.length, errorsBeforeResume, 'the resumed stop skips the released manager silently')
      t.pass('the old stop path resumes without touching the server')
    } finally { barrier.resolve(); await harness.close(); sinon.restore() }
  })
}

test('a force-released stop finishes on its own even if the checkpoint queue never settles', async t => {
  const harness = await startHarness()
  const barrier = blockCheckpoints(harness.service)
  try {
    const receipt = await bounded(harness.service.stopWithReceipt({ timeoutMilliseconds: 50 }))
    assert.equal(receipt.forced, true)
    await bounded(until((): boolean => stoppingTask(harness.service) === undefined, 'stop task to finish'))
    const startedAt = Date.now()
    await bounded(harness.service.stop())
    assert.ok(Date.now() - startedAt < 1000, 'a later stop() is not stuck behind the abandoned drain')
    assert.equal(harness.service.state.inactive(), true, 'the service state settles as inactive')
    assert.equal(harness.stops(), 0)
    t.pass('the ServiceCtl state does not stay pending on an abandoned manager')
  } finally { barrier.resolve(); await harness.close(); sinon.restore() }
})

test('a force-released service starts again on a new manager once its own storage answers', async t => {
  const harness = await startHarness()
  const barrier = blockCheckpoints(harness.service)
  try {
    const receipt = await bounded(harness.service.stopWithReceipt({ timeoutMilliseconds: 50 }))
    assert.equal(receipt.forced, true)
    await bounded(until((): boolean => stoppingTask(harness.service) === undefined, 'stop task to finish'))
    // The cursor read of the new start shares the checkpoint queue; a storage that answers again unblocks it.
    ;(harness.service as unknown as { checkpointQueue: Promise<void> }).checkpointQueue = Promise.resolve()
    await bounded(harness.service.start())
    const revived = harness.service.currentManager
    assert.ok(revived && revived !== harness.manager, 'a new manager serves the restarted service')
    assert.equal(harness.stops(), 0, 'the abandoned manager never sent Stop')
    t.pass('restart after a forced release does not wait for the abandoned drain')
  } finally { barrier.resolve(); await harness.close(); sinon.restore() }
})

test('a plain stop() that fails to release still reports released=false on the next receipt', async t => {
  const harness = await startHarness()
  const client = (harness.manager as unknown as { _client: puppet.PuppetClient })._client
  const close = sinon.stub(client, 'close').throws(new Error('close failed'))
  try {
    await bounded(harness.service.stop())
    const failed = await bounded(harness.service.stopWithReceipt())
    assert.equal(failed.released, false, 'a release that failed during a plain stop is not reported as released')
    assert.match(String(failed.releaseError?.message), /close failed/)
    close.restore()
    const retried = await bounded(harness.service.stopWithReceipt())
    assert.equal(retried.released, true)
    assert.equal(harness.stops(), 1, 'the retry releases locally without another Stop')
    t.pass('stop() keeps the manager whose release failed')
  } finally { close.restore(); await harness.close(); sinon.restore() }
})

test('start() keeps a manager whose release keeps failing instead of dropping its retry entry', async t => {
  const harness = await startHarness()
  const client = (harness.manager as unknown as { _client: puppet.PuppetClient })._client
  const close = sinon.stub(client, 'close').throws(new Error('close failed'))
  try {
    const failed = await bounded(harness.service.stopWithReceipt())
    assert.equal(failed.released, false)
    await bounded(harness.service.start())
    const pending = (harness.service as unknown as { pendingReleases: Set<GrpcManager> }).pendingReleases
    assert.ok(pending.has(harness.manager), 'the failed manager is still tracked after the service started again')
    close.restore()
    const receipt = await bounded(harness.service.stopWithReceipt())
    assert.equal(receipt.released, true, 'every pending manager is released and reported')
    assert.equal(pending.size, 0)
    t.pass('no retry entry is lost across start()')
  } finally { close.restore(); await harness.close(); sinon.restore() }
})

test('a manager that failed to release is retried and dropped when the service starts again', async t => {
  const harness = await startHarness()
  const client = (harness.manager as unknown as { _client: puppet.PuppetClient })._client
  const close = sinon.stub(client, 'close').throws(new Error('close failed'))
  try {
    const failed = await bounded(harness.service.stopWithReceipt())
    assert.equal(failed.released, false)
    close.restore()
    const pending = (harness.service as unknown as { pendingReleases: Set<GrpcManager> }).pendingReleases
    assert.ok(pending.has(harness.manager))
    await bounded(harness.service.start())
    assert.equal(pending.size, 0, 'no stale reference after a new start')
    assert.equal(harness.manager.releaseState().released, true, 'the stale manager was released again')
    t.pass('start() does not leave an unreleased manager behind')
  } finally { close.restore(); await harness.close(); sinon.restore() }
})

test('a failed Stop RPC is reported while the transport is still released', async t => {
  const harness = await startHarness({ failStop: true })
  try {
    const receipt = await bounded(harness.service.stopWithReceipt())
    assert.equal(receipt.released, true)
    assert.equal(receipt.serverAcked, false)
    assert.equal(receipt.forced, false)
    assert.match(String(receipt.stopError?.message), /stop refused/)
    assert.equal(harness.stops(), 1)
    t.pass('a server failure does not make the local release look failed')
  } finally { await harness.close(); sinon.restore() }
})

test('a client close failure is reported and retried by the next call', async t => {
  const harness = await startHarness()
  const client = (harness.manager as unknown as { _client: puppet.PuppetClient })._client
  const close = sinon.stub(client, 'close').throws(new Error('close failed'))
  try {
    const failed = await bounded(harness.service.stopWithReceipt())
    assert.equal(failed.released, false)
    assert.equal(failed.serverAcked, true)
    assert.match(String(failed.releaseError?.message), /close failed/)
    close.restore()
    const retried = await bounded(harness.service.stopWithReceipt())
    assert.notEqual(retried, failed)
    assert.deepEqual(retried, { released: true, serverAcked: true, forced: false })
    assert.equal(harness.stops(), 1, 'the retry releases locally without another Stop')
    t.pass('an unreleased manager is kept until a retry releases it')
  } finally { close.restore(); await harness.close(); sinon.restore() }
})

test('an event stream destroy failure is reported and retried by the next call', async t => {
  const harness = await startHarness()
  const stream = harness.manager.eventStream
  if (!stream) { throw new Error('the manager has no event stream') }
  const destroy = sinon.stub(stream, 'destroy').throws(new Error('destroy failed'))
  try {
    const failed = await bounded(harness.service.stopWithReceipt())
    assert.equal(failed.released, false)
    assert.match(String(failed.releaseError?.message), /destroy failed/)
    destroy.restore()
    const retried = await bounded(harness.service.stopWithReceipt())
    assert.equal(retried.released, true)
    assert.equal(retried.releaseError, undefined)
    t.pass('the stream that failed to destroy is retried')
  } finally { destroy.restore(); await harness.close(); sinon.restore() }
})

test('without a manager the receipt reports a released transport', async t => {
  const service = new ReceiptService({ token: `insecure_${randomUUID()}` })
  try {
    assert.deepEqual(await bounded(service.stopWithReceipt()), { released: true, serverAcked: false, forced: false })
    t.pass('nothing to release is released')
  } finally { await service.cleanup() }
})

test('concurrent calls share one receipt and send a single Stop', async t => {
  const harness = await startHarness()
  try {
    const first = harness.service.stopWithReceipt()
    const second = harness.service.stopWithReceipt()
    assert.equal(first, second, 'concurrent calls share the receipt promise')
    const stopping = harness.service.stop()
    assert.deepEqual(await bounded(first), { released: true, serverAcked: true, forced: false })
    await bounded(stopping)
    assert.equal(harness.stops(), 1)
    t.pass('a stop already in progress is reused')
  } finally { await harness.close(); sinon.restore() }
})
