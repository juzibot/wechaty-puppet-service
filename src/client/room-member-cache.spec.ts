import { test, sinon } from 'tstest'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'
import type * as PUPPET from '@juzi/wechaty-puppet'

import { PuppetService } from './puppet-service.js'
import { GrpcManager } from './grpc-manager.js'
import { roomPayloadToPb, roomMemberPayloadToPb } from '../utils/pb-payload-helper.js'

interface Deferred<Value> {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (reason: unknown) => void
}

interface ResetFixture {
  service: PuppetService
  manager: GrpcManager
  metadata: Map<string, string>
  started: Deferred<void>
  release: Deferred<void>
  stop: { readonly callCount: number }
  start: { readonly callCount: number, readonly args: readonly unknown[][] }
}

function deferred<Value> (): Deferred<Value> {
  let finish: (value: Value) => void = (): void => { throw new Error('Uninitialized resolver') }
  let fail: (reason: unknown) => void = (): void => { throw new Error('Uninitialized rejection') }
  const promise = new Promise<Value>((resolve, reject) => { finish = resolve; fail = reject })
  return { promise, resolve: finish, reject: fail }
}

class BridgedService extends PuppetService {

  connect (manager: GrpcManager): void { this._grpcManager = manager; this.bridgeGrpcEventStream(manager) }

}

let fixtureId = 0
function serviceFixture (): BridgedService {
  const service = new BridgedService({ token: `insecure_cache-${process.pid}-${fixtureId++}` })
  Object.defineProperty(service, 'eventWriteRetryDelays', { value: [ 1, 1, 1 ] })
  return service
}

async function settle (): Promise<void> {
  for (let i = 0; i < 20; i++) { await new Promise<void>(resolve => setTimeout(resolve, 2)) }
}

function event (payload: unknown, seq = 2): grpcPuppet.EventResponse {
  const response = new grpcPuppet.EventResponse()
  response.setType(grpcPuppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD)
  response.setSeq(seq)
  response.setPayload(JSON.stringify(payload))
  return response
}

const state = { roomId: 'room' }

async function drain (): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

function resetFixture (remove: () => Promise<void> = async (): Promise<void> => {}): ResetFixture {
  const service = serviceFixture()
  const manager = new GrpcManager({ token: 'insecure_token' })
  const metadata = new Map([ [ 'lastEventSeq', '1' ], [ 'lastEventTimestamp', String(Date.now()) ], [ 'accountId', 'account' ] ])
  Object.defineProperty(service, '_payloadStore', {
    value: {
      start: async (): Promise<void> => {},
      stop: async (): Promise<void> => {},
      room: { delete: remove },
      roomMember: { delete: async (): Promise<void> => {} },
      miscellaneous: {
        get: async (key: string): Promise<string | undefined> => metadata.get(key),
        set: async (key: string, value: string): Promise<void> => { metadata.set(key, value) },
        delete: async (key: string): Promise<void> => { metadata.delete(key) },
      },
    },
  })
  service.login('account')
  const stop = sinon.stub(manager, 'stopStream')
  const started = deferred<void>()
  const release = deferred<void>()
  const start = sinon.stub(manager, 'startStream').callsFake(async (): Promise<void> => {
    started.resolve()
    await release.promise
  })
  service.connect(manager)
  return { service, manager, metadata, stop, start, started, release }
}

async function finishResetHandshake (fixture: ResetFixture): Promise<void> {
  fixture.release.resolve()
  await drain()
  const login = new grpcPuppet.EventResponse()
  login.setType(grpcPuppet.EventType.EVENT_TYPE_LOGIN)
  login.setPayload(JSON.stringify({ contactId: 'account' }))
  fixture.manager.emit('data', login)
  const ready = new grpcPuppet.EventResponse()
  ready.setType(grpcPuppet.EventType.EVENT_TYPE_READY)
  ready.setPayload(JSON.stringify({ data: 'ready' }))
  fixture.manager.emit('data', ready)
  await drain()
}

test('bridge cache failure is retried, reported, and still releases room-member-load', async t => {
  const service = serviceFixture()
  const manager = new GrpcManager({ token: 'insecure_token' })
  const metadata = new Map<string, string>([ [ 'lastEventSeq', '1' ], [ 'lastEventTimestamp', String(Date.now()) ] ])
  const deleteRoom = sinon.stub().callsFake(async (id: string): Promise<void> => {
    if (id === 'room') { throw new Error('persistent cache unavailable') }
  })
  Object.defineProperty(service, '_payloadStore', {
    value: {
      room: { delete: deleteRoom },
      roomMember: { delete: sinon.stub().resolves() },
      miscellaneous: {
        get: async (key: string): Promise<string | undefined> => metadata.get(key),
        set: async (key: string, value: string): Promise<void> => { metadata.set(key, value) },
      },
    },
  })
  const stop = sinon.stub(manager, 'stopStream')
  const start = sinon.stub(manager, 'startStream').resolves()
  const errors = sinon.spy()
  const completed: string[] = []
  const unhandled = sinon.spy()
  process.on('unhandledRejection', unhandled)
  t.teardown((): void => { process.off('unhandledRejection', unhandled) })
  service.on('error', errors)
  service.on('room-member-load', ({ roomId }): void => { completed.push(roomId) })
  service.connect(manager)
  manager.emit('data', event(state))
  manager.emit('data', event({ roomId: 'other-room' }, 3))
  await settle()
  t.equal(unhandled.callCount, 0)
  t.equal(deleteRoom.withArgs('room').callCount, 4, 'one attempt plus three retries')
  t.equal(errors.callCount, 1)
  t.same(completed, [ 'room', 'other-room' ], 'loading listeners are released even when the cache delete failed')
  t.equal(metadata.get('lastEventSeq'), '3')
  t.equal(stop.callCount, 0)
  t.equal(start.callCount, 0)
})

test('invalid event payloads are dropped without touching cache, emitting, or halting the stream', async t => {
  for (const payload of [
    {}, null, 'room', { roomId: '' }, { roomId: '   ' }, { roomId: 1 }, { roomId: undefined },
  ]) {
    const service = serviceFixture()
    const manager = new GrpcManager({ token: 'insecure_token' })
    const remove = sinon.stub().resolves()
    Object.defineProperty(service, '_payloadStore', { value: { room: { delete: remove }, roomMember: { delete: remove } } })
    sinon.stub(manager, 'stopStream')
    sinon.stub(manager, 'startStream').resolves()
    const errors = sinon.spy()
    const completed = sinon.spy()
    service.on('error', errors)
    service.on('room-member-load', completed)
    service.connect(manager)
    manager.emit('data', event(payload))
    await drain()
    t.equal(remove.callCount, 0)
    t.equal(completed.callCount, 0)
    t.equal(errors.callCount, 0, `${JSON.stringify(payload)} is dropped, not a stream failure`)
  }
})

test('all four raw RPC reads begun before invalidation cannot refill persistent caches', async t => {
  const room: PUPPET.payloads.Room = { id: 'room', topic: 'old', adminIdList: [], memberIdList: [] }
  const member: PUPPET.payloads.RoomMember = { id: 'member', name: 'old', avatar: '' }
  for (const method of [ 'room', 'batchRoom', 'member', 'batchMember' ]) {
    const responseReady = deferred<void>()
    const requested = deferred<void>()
    const service = serviceFixture()
    const manager = new GrpcManager({ token: 'insecure_token' })
    const rooms = new Map<string, PUPPET.payloads.Room>()
    const members = new Map<string, Record<string, PUPPET.payloads.RoomMember>>()
    Object.defineProperty(service, '_payloadStore', {
      value: {
        room: {
          get: async (id: string): Promise<PUPPET.payloads.Room | undefined> => rooms.get(id),
          set: async (id: string, value: PUPPET.payloads.Room): Promise<void> => { rooms.set(id, value) },
          delete: async (id: string): Promise<void> => { rooms.delete(id) },
        },
        roomMember: {
          get: async (id: string): Promise<Record<string, PUPPET.payloads.RoomMember> | undefined> => members.get(id),
          set: async (id: string, value: Record<string, PUPPET.payloads.RoomMember>): Promise<void> => { members.set(id, value) },
          delete: async (id: string): Promise<void> => { members.delete(id) },
        },
      },
    })
    const wait = async (): Promise<void> => { requested.resolve(); await responseReady.promise }
    const respond = async <Response>(response: Response, callback: (error: Error | null, value: Response) => void): Promise<void> => {
      await wait()
      callback(null, response)
    }
    const client = {
      roomPayload: (_request: grpcPuppet.RoomPayloadRequest, callback: (error: Error | null, response: grpcPuppet.RoomPayloadResponse) => void): void => {
        void respond(roomPayloadToPb(room), callback)
      },
      batchRoomPayload: (_request: grpcPuppet.BatchRoomPayloadRequest, callback: (error: Error | null, response: grpcPuppet.BatchRoomPayloadResponse) => void): void => {
        const response = new grpcPuppet.BatchRoomPayloadResponse()
        response.setRoomPayloadsList([ roomPayloadToPb(room) ])
        void respond(response, callback)
      },
      roomMemberPayload: (_request: grpcPuppet.RoomMemberPayloadRequest, callback: (error: Error | null, response: grpcPuppet.RoomMemberPayloadResponse) => void): void => {
        void respond(roomMemberPayloadToPb(member), callback)
      },
      batchRoomMemberPayload: (_request: grpcPuppet.BatchRoomMemberPayloadRequest, callback: (error: Error | null, response: grpcPuppet.BatchRoomMemberPayloadResponse) => void): void => {
        const response = new grpcPuppet.BatchRoomMemberPayloadResponse()
        response.setMemberPayloadsList([ roomMemberPayloadToPb(member) ])
        void respond(response, callback)
      },
    }
    Object.defineProperty(service, 'grpcManager', { value: { client } })
    service.on('error', (error: unknown): void => { t.fail(String(error)) })
    service.connect(manager)
    const pending = method === 'room' ? service.roomRawPayload('room')
      : method === 'batchRoom' ? service.batchRoomRawPayload([ 'room' ])
        : method === 'member' ? service.roomMemberRawPayload('room', 'member')
          : service.batchRoomMemberRawPayload('room', [ 'member' ])
    await requested.promise
    manager.emit('data', event(state, 0))
    await drain()
    responseReady.resolve()
    await pending
    t.equal(rooms.size, 0, method)
    t.equal(members.size, 0, method)
  }
})

test('invalidation waits for an already-started asynchronous cache write', async t => {
  const service = serviceFixture()
  const manager = new GrpcManager({ token: 'insecure_token' })
  const writing = deferred<void>()
  const finishWrite = deferred<void>()
  let stored: PUPPET.payloads.Room | undefined
  const room: PUPPET.payloads.Room = { id: 'room', topic: 'old', adminIdList: [], memberIdList: [] }
  const remove = sinon.stub().callsFake(async (): Promise<void> => { stored = undefined })
  Object.defineProperty(service, '_payloadStore', {
    value: {
      room: {
        get: async (): Promise<PUPPET.payloads.Room | undefined> => stored,
        set: async (_id: string, value: PUPPET.payloads.Room): Promise<void> => {
          writing.resolve()
          await finishWrite.promise
          stored = value
        },
        delete: remove,
      },
    },
  })
  Object.defineProperty(service, 'grpcManager', {
    value: {
      client: {
        roomPayload: (_request: grpcPuppet.RoomPayloadRequest, callback: (error: Error | null, response: grpcPuppet.RoomPayloadResponse) => void): void => callback(null, roomPayloadToPb(room)),
      },
    },
  })
  service.connect(manager)
  const loaded = sinon.spy()
  service.on('room-member-load', loaded)
  const pending = service.roomRawPayload('room')
  await writing.promise
  manager.emit('data', event(state, 0))
  await drain()
  t.equal(remove.callCount, 0)
  t.equal(loaded.callCount, 0)
  finishWrite.resolve()
  await pending
  await drain()
  t.equal(stored, undefined)
  t.equal(loaded.callCount, 1)
})

test('a skipped event never halts later events or causes a restart', async t => {
  for (const gap of [ false, true ]) {
    const service = serviceFixture()
    const manager = new GrpcManager({ token: 'insecure_token' })
    const metadata = new Map<string, string>([ [ 'lastEventSeq', '1' ] ])
    let failing = true
    Object.defineProperty(service, '_payloadStore', {
      value: {
        room: { delete: sinon.stub().callsFake(async (): Promise<void> => { if (failing) { throw new Error('persistent cache unavailable') } }) },
        roomMember: { delete: sinon.stub().resolves() },
        miscellaneous: {
          get: async (key: string): Promise<string | undefined> => metadata.get(key),
          set: async (key: string, value: string): Promise<void> => { metadata.set(key, value) },
        },
      },
    })
    const stop = sinon.stub(manager, 'stopStream')
    const start = sinon.stub(manager, 'startStream').resolves()
    const errors = sinon.spy()
    const completed = sinon.spy()
    service.on('error', errors)
    service.on('room-member-load', completed)
    service.connect(manager)
    manager.emit('data', event(state))
    await settle()
    failing = false
    manager.emit('data', event(state, gap ? 4 : 3))
    await settle()
    t.equal(start.callCount, 0)
    t.equal(stop.callCount, 0)
    t.equal(errors.callCount, 1)
    t.equal(completed.callCount, 2)
    t.equal(metadata.get('lastEventSeq'), gap ? '4' : '3')
  }
})

test('duplicate reset does not invalidate events queued by the owner reset', async t => {
  const fixture = resetFixture()
  const completed = sinon.spy()
  fixture.service.on('room-member-load', completed)
  const resetting = fixture.service.reset()
  await fixture.started.promise
  fixture.release.resolve()
  await drain()
  const login = new grpcPuppet.EventResponse()
  login.setType(grpcPuppet.EventType.EVENT_TYPE_LOGIN)
  login.setPayload(JSON.stringify({ contactId: 'account' }))
  fixture.manager.emit('data', login)
  await drain()
  fixture.manager.emit('data', event(state))
  await fixture.service.reset()
  await drain()
  t.equal(completed.callCount, 1)
  t.equal(fixture.metadata.get('lastEventSeq'), '2')
  t.equal(fixture.start.callCount, 1)
  await finishResetHandshake(fixture)
  await resetting
})

test('superseded delete rejection cannot stop the stream established by reset', async t => {
  const removing = deferred<void>()
  const began = deferred<void>()
  const remove = sinon.stub().onFirstCall().callsFake(async (): Promise<void> => { began.resolve(); await removing.promise })
  remove.onSecondCall().resolves()
  const fixture = resetFixture(remove)
  const errors = sinon.spy()
  const completed = sinon.spy()
  fixture.service.on('error', errors)
  fixture.service.on('room-member-load', completed)
  fixture.manager.emit('data', event(state))
  await began.promise
  const resetting = fixture.service.reset()
  await fixture.started.promise
  await finishResetHandshake(fixture)
  await resetting
  removing.reject(new Error('old delete rejected after reset'))
  await drain()
  t.equal(fixture.stop.callCount, 1)
  t.equal(fixture.start.callCount, 1)
  t.equal(errors.callCount, 0)
  t.equal(completed.callCount, 0)
  t.equal(fixture.metadata.get('lastEventSeq'), '1')
  fixture.manager.emit('data', event(state))
  await drain()
  t.equal(completed.callCount, 1)
  t.equal(fixture.metadata.get('lastEventSeq'), '2')
})

test('an error listener that resets after a skipped event reconnects from the advanced cursor', async t => {
  const fixture = resetFixture()
  let failing = true
  fixture.service.on('room-member-load', (): void => { if (failing) { failing = false; throw new Error('listener failed') } })
  const resetting = deferred<Promise<void>>()
  fixture.service.on('error', (): void => { resetting.resolve(fixture.service.reset()) })
  fixture.manager.emit('data', event(state))
  await fixture.started.promise
  t.equal(fixture.start.callCount, 1)
  t.same(fixture.start.args[0], [ '2', 'account' ], 'the skipped event is not replayed again')
  await finishResetHandshake(fixture)
  await resetting.promise
  fixture.manager.emit('data', event(state, 3))
  await settle()
  t.equal(fixture.metadata.get('lastEventSeq'), '3')
})

test('reset waits for and rolls back a superseded asynchronous cursor commit before resuming', async t => {
  const fixture = resetFixture()
  const writing = deferred<void>()
  const finishWrite = deferred<void>()
  Object.defineProperty(fixture.service, '_payloadStore', {
    value: {
      start: async (): Promise<void> => {},
      stop: async (): Promise<void> => {},
      room: { delete: async (): Promise<void> => {} },
      roomMember: { delete: async (): Promise<void> => {} },
      miscellaneous: {
        get: async (key: string): Promise<string | undefined> => fixture.metadata.get(key),
        set: async (key: string, value: string): Promise<void> => {
          if (key === 'lastEventSeq' && value === '2') { writing.resolve(); await finishWrite.promise }
          fixture.metadata.set(key, value)
        },
        delete: async (key: string): Promise<void> => { fixture.metadata.delete(key) },
      },
    },
  })
  fixture.manager.emit('data', event(state))
  await writing.promise
  const resetting = fixture.service.reset()
  await drain()
  t.equal(fixture.start.callCount, 0)
  finishWrite.resolve()
  await fixture.started.promise
  t.same(fixture.start.args[0], [ '1', 'account' ])
  t.equal(fixture.metadata.get('lastEventSeq'), '1')
  await finishResetHandshake(fixture)
  await resetting
})

test('explicit reset after a skipped event resumes normal processing', async t => {
  const fixture = resetFixture()
  let failing = true
  const errors = sinon.spy()
  const completed = sinon.spy()
  fixture.service.on('error', errors)
  fixture.service.on('room-member-load', (): void => { completed(); if (failing) { failing = false; throw new Error('listener failed') } })
  fixture.manager.emit('data', event(state))
  await settle()
  t.equal(fixture.start.callCount, 0)
  t.equal(errors.callCount, 1)
  const resetting = fixture.service.reset()
  await fixture.started.promise
  await finishResetHandshake(fixture)
  await resetting
  fixture.manager.emit('data', event(state, 3))
  await settle()
  t.equal(errors.callCount, 1)
  t.equal(completed.callCount, 2)
  t.equal(fixture.metadata.get('lastEventSeq'), '3')
})

test('explicit reset uses the actual durable cursor without age fallback or invented zero', async t => {
  for (const absent of [ false, true ]) {
    const fixture = resetFixture()
    fixture.metadata.set('lastEventTimestamp', '0')
    if (absent) { fixture.metadata.delete('lastEventSeq') }
    const resetting = fixture.service.reset()
    await fixture.started.promise
    t.same(fixture.start.args[0], [ absent ? undefined : '1', 'account' ])
    await finishResetHandshake(fixture)
    await resetting
    t.equal(fixture.metadata.get('lastEventSeq'), absent ? undefined : '1')
  }
})
