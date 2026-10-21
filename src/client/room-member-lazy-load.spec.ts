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
  close: () => Promise<void>
}

async function createRpcFixture (adapter: PUPPET.impls.PuppetInterface): Promise<RpcFixture> {
  const server = new grpc.Server()
  server.addService(grpcPuppet.PuppetService, puppetImplementation(adapter, FileBox))
  const port = await util.promisify(server.bindAsync.bind(server))(
    '127.0.0.1:0', grpc.ServerCredentials.createInsecure(),
  )
  const client = new grpcPuppet.PuppetClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure())
  const service = new PuppetService({ token: `insecure_lazy-load-rpc-${process.pid}-${port}` })
  Object.defineProperty(service, 'grpcManager', { value: { client } })
  return {
    adapter,
    service,
    close: async (): Promise<void> => {
      client.close()
      await util.promisify(server.tryShutdown.bind(server))()
    },
  }
}

// The published mock resolves its own older Puppet; graft the 1.1.0 default so it matches a legacy adapter.
function mockAdapter (): PUPPET.impls.PuppetInterface {
  return Object.assign(new PuppetMock(), {
    roomMemberLazyLoadNow: PUPPET.Puppet.prototype.roomMemberLazyLoadNow,
  }) as unknown as PUPPET.impls.PuppetInterface
}

function eventResponse (type: number, payload: unknown): grpcPuppet.EventResponse {
  const response = new grpcPuppet.EventResponse()
  response.setType(type as grpcPuppet.EventTypeMap[keyof grpcPuppet.EventTypeMap])
  response.setPayload(JSON.stringify(payload))
  return response
}

let fixtureId = 0
function serviceFixture (): PuppetService {
  return new PuppetService({ token: `insecure_lazy-load-${process.pid}-${fixtureId++}` })
}

async function deliverEvent (service: PuppetService, event: grpcPuppet.EventResponse): Promise<void> {
  const handler: unknown = Reflect.get(service, 'onGrpcStreamEvent')
  if (typeof handler !== 'function') { throw new Error('Missing event handler') }
  await handler.call(service, event)
}

test('event type map knows 39 and 41', async t => {
  t.equal(EventTypeRev[39], 'EVENT_TYPE_ROOM_MEMBER_LOAD')
  t.equal(EventTypeRev[41], 'EVENT_TYPE_ROOM_MEMBER_LAZY_LOAD_FINISHED')
})

test('RoomMemberLazyLoadNow round-trips over real gRPC to the adapter', async t => {
  const { adapter, service, close } = await createRpcFixture(mockAdapter())
  t.teardown(close)
  const loadNow = sinon.stub(adapter, 'roomMemberLazyLoadNow').resolves()
  await service.roomMemberLazyLoadNow()
  t.equal(loadNow.callCount, 1)
  t.same(loadNow.args[0], [])
})

test('RoomMemberLazyLoadNow maps unsupported adapters to UNIMPLEMENTED and keeps other errors', async t => {
  const { adapter, service, close } = await createRpcFixture(mockAdapter())
  t.teardown(close)
  await t.rejects(service.roomMemberLazyLoadNow(), {
    code: grpc.status.UNIMPLEMENTED,
    details: 'roomMemberLazyLoadNow is unsupported by this puppet',
  })

  sinon.stub(adapter, 'roomMemberLazyLoadNow').rejects(new Error('account offline'))
  await t.rejects(service.roomMemberLazyLoadNow(), (error: unknown): boolean =>
    (error as grpc.ServiceError).code !== grpc.status.UNIMPLEMENTED
    && /account offline/.test((error as grpc.ServiceError).details),
  )
})

test('RoomMemberLazyLoadNow is UNIMPLEMENTED when an older adapter lacks the method', async t => {
  const legacy = Object.defineProperty(new PuppetMock(), 'roomMemberLazyLoadNow', { value: undefined })
  const { service, close } = await createRpcFixture(legacy as unknown as PUPPET.impls.PuppetInterface)
  t.teardown(close)
  await t.rejects(service.roomMemberLazyLoadNow(), { code: grpc.status.UNIMPLEMENTED })
})

test('event 39 invalidates persistent and in-memory room caches before emitting {roomId}', async t => {
  const service = serviceFixture()
  await service.cache.start()
  t.teardown(() => service.cache.stop())
  service.cache.room?.set('room', { id: 'room', topic: '', adminIdList: [], memberIdList: [] })
  service.cache.roomMember?.set('room', { member: { id: 'member', name: '', avatar: '' } })
  service.on('room-member-load', service.onRoomMemberLoad.bind(service))

  const deleted: string[] = []
  Object.defineProperty(service, '_payloadStore', {
    value: {
      room: { delete: async (id: string): Promise<void> => { deleted.push(`room:${id}`) } },
      roomMember: { delete: async (id: string): Promise<void> => { deleted.push(`member:${id}`) } },
    },
  })
  const received: PUPPET.payloads.EventRoomMemberLoad[] = []
  service.on('room-member-load', (payload): void => {
    t.same(deleted, [ 'room:room', 'member:room' ], 'persistent caches are cleared before listeners run')
    received.push(payload)
  })

  await deliverEvent(service, eventResponse(grpcPuppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD, { roomId: 'room', extra: 1 }))

  t.same(received, [ { roomId: 'room' } ], 'only roomId is forwarded')
  t.equal(service.cache.room?.get('room'), undefined)
  t.equal(service.cache.roomMember?.get('room'), undefined)
})

test('event 39 with an invalid payload is logged and dropped', async t => {
  for (const payload of [ {}, null, [], 'room', { roomId: '' }, { roomId: ' ' }, { roomId: 7 } ]) {
    const service = serviceFixture()
    const remove = sinon.stub().resolves()
    Object.defineProperty(service, '_payloadStore', { value: { room: { delete: remove }, roomMember: { delete: remove } } })
    const warn = sinon.spy(service.log, 'warn')
    const loaded = sinon.spy()
    service.on('room-member-load', loaded)

    await deliverEvent(service, eventResponse(grpcPuppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD, payload))

    t.equal(loaded.callCount, 0, `${JSON.stringify(payload)} not emitted`)
    t.equal(remove.callCount, 0, `${JSON.stringify(payload)} leaves cache untouched`)
    t.ok(warn.args.some(args => args.some(arg => typeof arg === 'string' && arg.includes('invalid payload'))))
    warn.restore()
  }
})

test('event 41 is emitted as room-member-lazy-load-finished with an empty payload', async t => {
  const service = serviceFixture()
  const finished = sinon.spy()
  service.on('room-member-lazy-load-finished', finished)
  await deliverEvent(service, eventResponse(grpcPuppet.EventType.EVENT_TYPE_ROOM_MEMBER_LAZY_LOAD_FINISHED, {}))
  t.same(finished.args, [ [ {} ] ])
})

test('ready event keeps the data field from the server', async t => {
  for (const payload of [ { data: 'lazy' }, {} ]) {
    const service = serviceFixture()
    const ready = sinon.spy()
    service.on('ready', ready)
    await deliverEvent(service, eventResponse(grpcPuppet.EventType.EVENT_TYPE_READY, payload))
    t.same(ready.args, [ [ payload ] ])
  }
})

test('server forwards room-member-load, lazy-load-finished and ready data, then removes listeners', async t => {
  const adapter = new PuppetMock() as unknown as PUPPET.impls.PuppetInterface
  const manager = new EventStreamManager(adapter)
  const emit = sinon.stub(manager, 'grpcEmit')
  manager.connectPuppetEventToStreamingCall()

  adapter.emit('room-member-load', { roomId: 'room' })
  adapter.emit('room-member-lazy-load-finished', {})
  adapter.emit('ready', { data: 'lazy' })
  t.same(emit.args, [
    [ grpcPuppet.EventType.EVENT_TYPE_ROOM_MEMBER_LOAD, { roomId: 'room' } ],
    [ grpcPuppet.EventType.EVENT_TYPE_ROOM_MEMBER_LAZY_LOAD_FINISHED, {} ],
    [ grpcPuppet.EventType.EVENT_TYPE_READY, { data: 'lazy' } ],
  ])

  manager.removePuppetListeners()
  adapter.emit('room-member-load', { roomId: 'room' })
  adapter.emit('room-member-lazy-load-finished', {})
  t.equal(emit.callCount, 3)
})
