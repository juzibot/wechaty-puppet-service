import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { GrpcManager } from './grpc-manager.js'
import { PuppetService } from './puppet-service.js'

class AuthService extends PuppetService {

  attach (manager: GrpcManager): void { this._grpcManager = manager; this.bridgeGrpcEventStream(manager) }
  get store () { return this._payloadStore }
  async cleanup (): Promise<void> { await this.onStop(); await this._payloadStore.destroy() }

}

async function bounded<Result> (operation: Promise<Result>): Promise<Result> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([ operation, new Promise<never>((_resolve, reject): void => {
      timer = setTimeout((): void => { reject(new Error('test barrier timeout')) }, 5000)
    }) ])
  } finally { clearTimeout(timer) }
}

function response (type: ReturnType<puppet.EventResponse['getType']>, payload: unknown, seq = 0): puppet.EventResponse {
  const event = new puppet.EventResponse()
  event.setType(type); event.setPayload(JSON.stringify(payload)); event.setSeq(seq)
  return event
}

test('legacy Event snapshot plus Start LOGIN is idempotent', async t => {
  const server = new grpc.Server()
  let stream!: grpc.ServerWritableStream<puppet.EventRequest, puppet.EventResponse>
  const login = (): puppet.EventResponse => response(puppet.EventType.EVENT_TYPE_LOGIN, { contactId: 'A' })
  server.addService(puppet.PuppetService, {
    event: (call: typeof stream): void => {
      stream = call
      call.write(response(puppet.EventType.EVENT_TYPE_HEARTBEAT, {})); call.write(login())
    },
    start: (_call: grpc.ServerUnaryCall<puppet.StartRequest, puppet.StartResponse>, callback: grpc.sendUnaryData<puppet.StartResponse>): void => {
      stream.write(login()); callback(null, new puppet.StartResponse())
    },
    stop: (_call: grpc.ServerUnaryCall<puppet.StopRequest, puppet.StopResponse>, callback: grpc.sendUnaryData<puppet.StopResponse>): void => { callback(null, new puppet.StopResponse()) },
  })
  const port = await bounded(new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  }))
  const service = new AuthService({ token: `insecure_${randomUUID()}`, endpoint: `127.0.0.1:${port}`, tls: { disable: true }, recovery: { enabled: false } })
  sinon.stub(service.store, 'start').resolves(); sinon.stub(service.store, 'stop').resolves()
  let logins = 0
  service.on('login', (): void => { logins++ })
  const received = new Promise<void>((resolve): void => { service.once('dong', (): void => { resolve() }) })
  try {
    await bounded(service.onStart())
    stream.write(response(puppet.EventType.EVENT_TYPE_DONG, { data: 'after-two-logins' }))
    await bounded(received)
    await service.prepareForRestart({ deadline: Date.now() + 2000 })
    assert.equal(logins, 1); assert.equal(service.currentUserId, 'A')
    t.pass('duplicate notification leaves a clean drain')
  } finally { server.forceShutdown(); await bounded(service.cleanup()); sinon.restore() }
})
