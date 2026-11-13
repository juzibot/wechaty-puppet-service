import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { PuppetService } from './puppet-service.js'

class StartContextService extends PuppetService {

  get store () { return this._payloadStore }
  async cleanup (): Promise<void> { await this.onStop(); await this._payloadStore.destroy() }

}

async function bounded<Result> (operation: Promise<Result>, milliseconds = 4000): Promise<Result> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([ operation, new Promise<never>((_resolve, reject): void => {
      timer = setTimeout((): void => { reject(new Error('test barrier timeout')) }, milliseconds)
    }) ])
  } finally { clearTimeout(timer) }
}

function response (type: ReturnType<puppet.EventResponse['getType']>, payload: unknown): puppet.EventResponse {
  const event = new puppet.EventResponse()
  event.setType(type); event.setPayload(JSON.stringify(payload)); event.setSeq(0)
  return event
}

async function until (condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${label}`) }
    await new Promise<void>((resolve): void => { setTimeout(resolve, 5) })
  }
}

interface Calls { events: number, starts: number, stops: number }

interface Harness {
  readonly service: StartContextService
  readonly calls: Calls
  readonly write: (event: puppet.EventResponse) => void
  readonly close: () => Promise<void>
}

/** A loopback Work that logs account A in on every new event stream, counting the RPCs it receives. */
async function startHarness (recoveryEnabled: boolean): Promise<Harness> {
  const server = new grpc.Server()
  const calls: Calls = { events: 0, starts: 0, stops: 0 }
  let stream: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse> | undefined
  server.addService(puppet.PuppetService, {
    event: (call: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>): void => {
      calls.events++
      stream = call
      call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {}))
      call.write(response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' }))
      call.write(response(puppet.EventType.EVENT_TYPE_READY, {}))
      call.write(response(puppet.EventType.EVENT_TYPE_REPLAY_COMPLETE, { accountId: 'A', throughSeq: 0 }))
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => {
      calls.starts++
      callback(null, new puppet.StartResponse())
    },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => {
      calls.stops++
      callback(null, new puppet.StopResponse())
    },
  })
  const port = await bounded(new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  }))
  const service = new StartContextService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: recoveryEnabled } })
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  service.on('error', (): void => {})
  return {
    service,
    calls,
    write: (event): void => {
      if (!stream) { throw new Error('the server has no event stream yet') }
      stream.write(event)
    },
    close: async (): Promise<void> => { server.forceShutdown(); await bounded(service.cleanup()) },
  }
}

/** The listener restarts the transport from inside the event it is handling, as Nested's error recovery does. */
for (const trigger of [ 'logout', 'dong' ] as const) {
  test(`stop and start from a ${trigger} listener opens a new event stream and sends Start`, async t => {
    const harness = await startHarness(true)
    let restarted: Promise<void> | undefined
    const restart = async (): Promise<void> => {
      await harness.service.stop()
      await harness.service.start()
    }
    harness.service.on(trigger, (): void => {
      if (restarted) { return }
      // A later turn of the same async chain: the event's context is still the caller's.
      restarted = new Promise<void>((resolve): void => { setImmediate((): void => { restart().then(resolve, resolve) }) })
    })
    try {
      await bounded(harness.service.onStart())
      await bounded(until((): boolean => harness.service.isLoggedIn, 'login A'))
      assert.deepEqual({ events: harness.calls.events, starts: harness.calls.starts }, { events: 1, starts: 1 })
      harness.write(trigger === 'logout'
        ? response(puppet.EventType.EVENT_TYPE_LOGOUT, { contactId: 'A', data: 'kicked' })
        : response(puppet.EventType.EVENT_TYPE_DONG, { data: 'x' }))
      await bounded(until((): boolean => restarted !== undefined, `${trigger} listener`))
      await bounded(restarted!, 8000)
      assert.deepEqual(
        { events: harness.calls.events, starts: harness.calls.starts, stops: harness.calls.stops },
        { events: 2, starts: 2, stops: 1 },
        'the restart must reach the server: a new event stream, then Start',
      )
      await bounded(until((): boolean => harness.service.isLoggedIn, 'login A after restart'))
      t.pass('a transport rebuilt inside an event is not refused by that event\'s own epoch')
    } finally { await harness.close(); sinon.restore() }
  })
}
