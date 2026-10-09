import util from 'util'
import { sinon, test } from 'tstest'
import { FileBox } from 'file-box'
import * as PUPPET from '@juzi/wechaty-puppet'
import { PuppetMock } from '@juzi/wechaty-puppet-mock'
import { grpc, puppet as grpcPuppet } from '@juzi/wechaty-grpc'

import { PuppetService } from './puppet-service.js'
import { puppetImplementation } from '../server/puppet-implementation.js'
import { EventStreamManager } from '../server/event-stream-manager.js'
import { EventTypeRev } from '../event-type-rev.js'

interface RpcFixture {
  service: PuppetService
  adapter: PUPPET.impls.PuppetInterface
  client: grpcPuppet.PuppetClient
  close: () => Promise<void>
}

async function createRpcFixture (legacyAdapter?: PUPPET.impls.PuppetInterface): Promise<RpcFixture> {
  // The published mock resolves its own older Puppet dependency.
  const adapter = legacyAdapter ?? Object.assign(new PuppetMock(), {
    roomMemberSync: PUPPET.Puppet.prototype.roomMemberSync,
    roomMemberLoadState: PUPPET.Puppet.prototype.roomMemberLoadState,
    roomMemberSnapshot: PUPPET.Puppet.prototype.roomMemberSnapshot,
  }) as unknown as PUPPET.impls.PuppetInterface
  const server = new grpc.Server()
  server.addService(grpcPuppet.PuppetService, puppetImplementation(adapter, FileBox))
  const port = await util.promisify(server.bindAsync.bind(server))(
    '127.0.0.1:0', grpc.ServerCredentials.createInsecure(),
  )
  const client = new grpcPuppet.PuppetClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure())
  const service = new PuppetService({ token: `load-test-${port}` })
  Object.defineProperty(service, 'grpcManager', { value: { client } })
  return {
    adapter,
    service,
    client,
    close: async (): Promise<void> => {
      client.close()
      await util.promisify(server.tryShutdown.bind(server))()
    },
  }
}

const state: PUPPET.payloads.RoomMemberLoadState = {
  roomId: 'room', taskId: 'task', status: 3, revision: '9007199254740993', loadedAt: 123456789,
}

test('real gRPC sync, state, and snapshot roundtrip without dirty fallback', async t => {
  const { adapter, service, close } = await createRpcFixture()
  t.teardown(close)
  const accepted: PUPPET.payloads.RoomMemberLoadState = {
    roomId: 'room', taskId: 'task', status: PUPPET.types.RoomMemberLoadStatus.Pending, revision: '0',
  }
  const sync = sinon.stub(adapter, 'roomMemberSync').resolves(accepted)
  const read = sinon.stub(adapter, 'roomMemberLoadState').resolves(state)
  const snapshot = sinon.stub(adapter, 'roomMemberSnapshot').resolves({
    roomId: 'room',
    revision: state.revision,
    loadedAt: state.loadedAt,
    members: [ {
      id: 'member',
      name: 'name',
      avatar: 'avatar',
      roomAlias: 'alias',
      inviterId: 'inviter',
      additionalInfo: 'info',
      joinTime: 12,
      joinScene: 0,
    } ],
    nextPageToken: 'next',
  })
  const dirty = sinon.spy(adapter, 'dirtyPayload')
  t.same(await service.roomMemberSync('room', { force: true }), accepted, 'returns accepted Pending state without waiting for Loaded')
  t.same(sync.args[0], [ 'room', { force: true } ])
  await service.roomMemberSync('room')
  t.same(sync.args[1], [ 'room', undefined ], 'does not inject default force')
  t.same(await service.roomMemberLoadState('room'), state)
  t.equal(read.callCount, 1)
  const page = await service.roomMemberSnapshot('room', state.revision, { pageToken: 'cursor', pageSize: 2 })
  t.same(snapshot.args[0], [ 'room', state.revision, { pageToken: 'cursor', pageSize: 2 } ])
  t.equal(page.nextPageToken, 'next')
  t.equal(page.members[0]?.roomAlias, 'alias')
  t.equal(page.loadedAt, state.loadedAt)
  t.equal(dirty.callCount, 0)
  await service.roomMemberSnapshot('room', state.revision)
  t.same(snapshot.args[1], [ 'room', state.revision, { pageToken: '', pageSize: 0 } ])
  await t.rejects(service.roomMemberSnapshot('room', '01'), /revision/)
  await t.rejects(service.roomMemberSnapshot('room', '1', { pageSize: 501 }), /pageSize/)
})

test('snapshot conflicts and adapter unsupported errors keep standard gRPC status', async t => {
  const { adapter, service, close } = await createRpcFixture()
  t.teardown(close)
  const snapshot = sinon.stub(adapter, 'roomMemberSnapshot').resolves({ roomId: 'room', revision: '2', members: [] })
  await t.rejects(service.roomMemberSnapshot('room', '1'), { code: grpc.status.FAILED_PRECONDITION })
  snapshot.resolves({ roomId: 'other', revision: '1', members: [] })
  await t.rejects(service.roomMemberSnapshot('room', '1'), { code: grpc.status.FAILED_PRECONDITION })
  snapshot.rejects(Object.assign(new Error('snapshot not loaded'), { code: grpc.status.FAILED_PRECONDITION }))
  await t.rejects(service.roomMemberSnapshot('room', '1'), { code: grpc.status.FAILED_PRECONDITION })
  await t.rejects(service.roomMemberSync('room'), { code: grpc.status.UNIMPLEMENTED })
  await t.rejects(service.roomMemberLoadState('room'), { code: grpc.status.UNIMPLEMENTED })
  snapshot.restore()
  await t.rejects(service.roomMemberSnapshot('room', '1'), { code: grpc.status.UNIMPLEMENTED })
})

async function deliverEvent (service: PuppetService, event: grpcPuppet.EventResponse): Promise<void> {
  const handler: unknown = Reflect.get(service, 'onGrpcStreamEvent')
  if (typeof handler !== 'function') { throw new Error('Missing event handler') }
  await handler.call(service, event)
}

test('independent event waits for both persistent stores then invalidates base caches', async t => {
  const service = new PuppetService({ token: 'load-event-test' })
  await service.cache.start()
  t.teardown(() => service.cache.stop())
  service.cache.room?.set('room', { id: 'room', topic: '', adminIdList: [], memberIdList: [] })
  service.cache.roomMember?.set('room', { member: { id: 'member', name: '', avatar: '' } })
  service.on('room-member-load', service.onRoomMemberLoad.bind(service))
  let finishRoom: () => void = () => { throw new Error('Missing room resolver') }
  let finishMembers: () => void = () => { throw new Error('Missing members resolver') }
  const roomDeleted = new Promise<void>(resolve => { finishRoom = resolve })
  const membersDeleted = new Promise<void>(resolve => { finishMembers = resolve })
  const deleteRoom = sinon.stub().returns(roomDeleted)
  const deleteMembers = sinon.stub().returns(membersDeleted)
  Object.defineProperty(service, '_payloadStore', {
    value: { room: { delete: deleteRoom }, roomMember: { delete: deleteMembers } },
  })
  const dirty = sinon.spy(service, 'dirtyPayload')
  const dirtyEvent = sinon.spy()
  const load = sinon.spy()
  service.on('dirty', dirtyEvent)
  service.on('room-member-load', load)
  const event = new grpcPuppet.EventResponse()
  event.setType(grpcPuppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD)
  event.setPayload(JSON.stringify(state))
  const pending = deliverEvent(service, event)
  t.equal(load.callCount, 0)
  finishRoom()
  await Promise.resolve()
  t.equal(load.callCount, 0, 'second store still pending')
  finishMembers()
  await pending
  t.same(deleteRoom.args[0], [ 'room' ])
  t.same(deleteMembers.args[0], [ 'room' ])
  t.same(load.args[0], [ state ])
  t.equal(service.cache.room?.has('room'), false)
  t.equal(service.cache.roomMember?.has('room'), false)
  t.equal(dirty.callCount, 0)
  t.equal(dirtyEvent.callCount, 0)
  t.equal(EventTypeRev[39], 'EVENT_TYPE_ROOM_MEMBER_LOAD')
})

test('server forwards original room-member-load event and removes its listener', async t => {
  const adapter = new PuppetMock() as unknown as PUPPET.impls.PuppetInterface
  const manager = new EventStreamManager(adapter)
  const emit = sinon.stub(manager, 'grpcEmit')
  manager.connectPuppetEventToStreamingCall()
  adapter.emit('room-member-load', state)
  t.same(emit.args[0], [ grpcPuppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD, state ])
  manager.removePuppetListeners()
  adapter.emit('room-member-load', state)
  t.equal(emit.callCount, 1)
})

test('single and batch room payload RPCs retain every new field', async t => {
  const { adapter, service, close } = await createRpcFixture()
  t.teardown(close)
  const payload: PUPPET.payloads.Room = {
    id: 'room',
    topic: 'topic',
    avatar: 'avatar',
    handle: 'handle',
    ownerId: 'owner',
    adminIdList: [ 'admin' ],
    memberIdList: [],
    additionalInfo: 'info',
    remark: 'remark',
    external: true,
    createTime: 1234,
    memberCount: 8,
    memberLoadMode: 2,
    memberLoadStatus: 3,
    memberLoadRevision: state.revision,
    memberLoadedAt: 0,
  }
  sinon.stub(adapter, 'roomPayload').resolves(payload)
  sinon.stub(adapter, 'batchRoomPayload').resolves(new Map([ [ 'room', payload ] ]))
  t.same(await service.roomRawPayload('room'), payload)
  t.same((await service.batchRoomRawPayload([ 'room' ])).get('room'), payload)
})

test('malformed status and revision fail rather than falling back to dirty', async t => {
  const { adapter, service, close } = await createRpcFixture()
  t.teardown(close)
  const read = sinon.stub(adapter, 'roomMemberLoadState').resolves({ ...state, status: 99 })
  const dirty = sinon.spy(adapter, 'dirtyPayload')
  await t.rejects(service.roomMemberLoadState('room'), /status/)
  read.resolves({ ...state, revision: '01' })
  await t.rejects(service.roomMemberLoadState('room'), /revision/)
  read.resolves({ ...state, roomId: 'other' })
  await t.rejects(service.roomMemberLoadState('room'), /roomId/)
  t.equal(dirty.callCount, 0)
})

test('cache deletion failure rejects without announcing a successful load', async t => {
  const service = new PuppetService({ token: 'load-event-failure' })
  Object.defineProperty(service, '_payloadStore', {
    value: {
      room: { delete: async (): Promise<void> => { throw new Error('cache unavailable') } },
      roomMember: { delete: async (): Promise<void> => {} },
    },
  })
  const load = sinon.spy()
  service.on('room-member-load', load)
  const event = new grpcPuppet.EventResponse()
  event.setType(grpcPuppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD)
  event.setPayload(JSON.stringify(state))
  await t.rejects(deliverEvent(service, event), /cache unavailable/)
  t.equal(load.callCount, 0)
})

test('server enforces snapshot request bounds before invoking the adapter', async t => {
  const { adapter, client, close } = await createRpcFixture()
  t.teardown(close)
  const snapshot = sinon.stub(adapter, 'roomMemberSnapshot').resolves({ roomId: 'room', revision: '1', members: [] })
  const request = new grpcPuppet.RoomMemberSnapshotRequest()
  request.setId('room')
  request.setRevision('1')
  const invoke = util.promisify(client.roomMemberSnapshot.bind(client))
  request.setPageSize(501)
  await t.rejects(invoke(request), { code: grpc.status.INVALID_ARGUMENT })
  request.setPageSize(0)
  request.setRevision('01')
  await t.rejects(invoke(request), { code: grpc.status.INVALID_ARGUMENT })
  request.setRevision('1')
  request.setId('')
  await t.rejects(invoke(request), { code: grpc.status.INVALID_ARGUMENT })
  t.equal(snapshot.callCount, 0)
  request.setId('room')
  await invoke(request)
  t.same(snapshot.args[0], [ 'room', '1', { pageToken: '', pageSize: 0 } ])
  request.setPageSize(500)
  await invoke(request)
  t.same(snapshot.args[1], [ 'room', '1', { pageToken: '', pageSize: 500 } ])
})

test('all three RPCs preserve adapter error codes', async t => {
  const { adapter, service, close } = await createRpcFixture()
  t.teardown(close)
  const error = Object.assign(new Error('adapter capacity exhausted'), { code: grpc.status.RESOURCE_EXHAUSTED })
  sinon.stub(adapter, 'roomMemberSync').rejects(error)
  sinon.stub(adapter, 'roomMemberLoadState').rejects(error)
  sinon.stub(adapter, 'roomMemberSnapshot').rejects(error)
  await t.rejects(service.roomMemberSync('room'), { code: grpc.status.RESOURCE_EXHAUSTED })
  await t.rejects(service.roomMemberLoadState('room'), { code: grpc.status.RESOURCE_EXHAUSTED })
  await t.rejects(service.roomMemberSnapshot('room', '1'), { code: grpc.status.RESOURCE_EXHAUSTED })
})

test('unmodified legacy mock lacking new methods returns UNIMPLEMENTED', async t => {
  const legacy = new PuppetMock() as unknown as PUPPET.impls.PuppetInterface
  const { service, close } = await createRpcFixture(legacy)
  t.teardown(close)
  t.equal(typeof legacy.roomMemberSync, 'undefined')
  await t.rejects(service.roomMemberSync('room'), { code: grpc.status.UNIMPLEMENTED })
  await t.rejects(service.roomMemberLoadState('room'), { code: grpc.status.UNIMPLEMENTED })
  await t.rejects(service.roomMemberSnapshot('room', '1'), { code: grpc.status.UNIMPLEMENTED })
})

test('plain adapter status objects retain their original details', async t => {
  const { adapter, service, close } = await createRpcFixture()
  t.teardown(close)
  const logs = sinon.spy(PUPPET.log, 'error')
  t.teardown(() => logs.restore())
  sinon.stub(adapter, 'roomMemberSnapshot').rejects({ code: grpc.status.FAILED_PRECONDITION, details: 'revision retired' })
  await t.rejects(service.roomMemberSnapshot('room', '1'), { code: grpc.status.FAILED_PRECONDITION, details: 'revision retired' })
  t.equal(logs.args.some(args => args.includes('roomMemberSnapshot') && args.some(value => typeof value === 'string' && value.includes('revision retired'))), true)
})

test('server event validator rejects invalid state without forwarding a load event', async t => {
  const adapter = new PuppetMock() as unknown as PUPPET.impls.PuppetInterface
  const manager = new EventStreamManager(adapter)
  const emit = sinon.stub(manager, 'grpcEmit')
  const errors = sinon.spy()
  adapter.on('error', errors)
  manager.connectPuppetEventToStreamingCall()
  adapter.emit('room-member-load', { ...state, status: 99 })
  t.equal(errors.callCount, 1)
  t.equal(emit.args.some(args => args[0] === grpcPuppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD), false)
  manager.removePuppetListeners()
})

test('persistent batch cache failure rejects without retrying raw RPCs', async t => {
  const { adapter, service, close } = await createRpcFixture()
  t.teardown(close)
  const room: PUPPET.payloads.Room = { id: 'room', topic: '', adminIdList: [], memberIdList: [] }
  const member: PUPPET.payloads.RoomMember = { id: 'member', name: '', avatar: '' }
  sinon.stub(adapter, 'batchRoomPayload').resolves(new Map([ [ 'room', room ] ]))
  sinon.stub(adapter, 'batchRoomMemberPayload').resolves(new Map([ [ 'member', member ] ]))
  const roomFallback = sinon.spy(service, 'roomRawPayload')
  const memberFallback = sinon.spy(service, 'roomMemberRawPayload')
  const store = {
    get: async (): Promise<undefined> => undefined,
    set: async (): Promise<void> => { throw new Error('persistent cache unavailable') },
  }
  Object.defineProperty(service, '_payloadStore', { value: { room: store, roomMember: store } })
  await t.rejects(service.batchRoomRawPayload([ 'room' ]), /persistent cache unavailable/)
  await t.rejects(service.batchRoomMemberRawPayload('room', [ 'member' ]), /persistent cache unavailable/)
  t.equal(roomFallback.callCount, 0)
  t.equal(memberFallback.callCount, 0)
})
