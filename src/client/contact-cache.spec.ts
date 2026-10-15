import { test } from 'tstest'
import * as PUPPET from '@juzi/wechaty-puppet'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

import { PuppetService } from './puppet-service.js'

let fixtureId = 0

function contact (id: string, friend = false, handle = ''): PUPPET.payloads.Contact {
  return {
    id,
    name: 'contact',
    avatar: '',
    phone: [],
    gender: PUPPET.types.ContactGender.Unknown,
    type: PUPPET.types.Contact.Individual,
    friend,
    handle,
  }
}

async function fixture (cleanup: (operation: () => void) => void): Promise<PuppetService> {
  const service = new PuppetService({ token: `insecure_contact_cache-${process.pid}-${fixtureId++}` })
  await service.cache.start()
  cleanup(() => service.cache.stop())
  return service
}

function setStore (service: PuppetService, store?: unknown): void {
  Object.defineProperty(service, '_payloadStore', { value: { contact: store } })
}

async function dirty (service: PuppetService, id: string): Promise<void> {
  const event = new grpcPuppet.EventResponse()
  event.setType(grpcPuppet.EventType.EVENT_TYPE_DIRTY)
  event.setPayload(JSON.stringify({ payloadType: PUPPET.types.Dirty.Contact, payloadId: id }))
  const handler: unknown = Reflect.get(service, 'onGrpcStreamEvent')
  if (typeof handler !== 'function') { throw new Error('Missing event handler') }
  await handler.call(service, event)
}

test('contact dirty clears both caches before notifying consumers without a base dirty listener', async t => {
  const service = await fixture(operation => t.teardown(operation))
  const id = 'new-friend'
  const previous = contact(id)
  const current = contact(id, true, 'test-external-id')
  const persisted = new Map([ [ id, previous ] ])
  service.cache.contact?.set(id, previous)
  setStore(service, {
    get: async (key: string) => persisted.get(key),
    set: async (key: string, value: PUPPET.payloads.Contact) => { persisted.set(key, value) },
    delete: async (key: string) => persisted.delete(key),
  })

  let reads = 0
  const response = new grpcPuppet.ContactPayloadResponse()
  response.setId(id)
  response.setName(current.name)
  response.setFriend(true)
  response.setWeixin(current.handle!)
  response.setType(current.type)
  Object.defineProperty(service, 'grpcManager', {
    value: {
      client: {
        contactPayload: (_request: unknown, callback: (error: null, payload: grpcPuppet.ContactPayloadResponse) => void) => {
          reads++
          callback(null, response)
        },
      },
    },
  })

  let observed: PUPPET.payloads.Contact | undefined
  service.on('dirty', () => {
    t.notOk(service.cache.contact?.has(id), 'memory cache is already invalidated')
    t.notOk(persisted.has(id), 'persistent cache is already invalidated')
    observed = service.cache.contact?.get(id)
  })
  await dirty(service, id)
  t.notOk(observed)
  const refreshed = await service.contactPayload(id)
  t.equal(reads, 1, 'the next read reaches the upstream contact RPC')
  t.equal(refreshed.friend, true, 'the new friend state is visible')
  t.equal(refreshed.handle, current.handle, 'the external user ID is visible')
  t.equal(persisted.get(id)?.handle, current.handle, 'the fresh payload repopulates the persistent cache')
})

test('contact dirty waits for persistent deletion and leaves other contacts untouched', async t => {
  const service = await fixture(operation => t.teardown(operation))
  const target = contact('target')
  const other = contact('other', true, 'other-external-id')
  service.cache.contact?.set(target.id, target)
  service.cache.contact?.set(other.id, other)
  const persisted = new Map([ [ target.id, target ], [ other.id, other ] ])
  let release: () => void = () => { throw new Error('Missing deletion resolver') }
  const pending = new Promise<void>(resolve => { release = resolve })
  setStore(service, {
    delete: async (id: string) => {
      await pending
      persisted.delete(id)
    },
  })
  let notified = false
  service.on('dirty', () => { notified = true })

  const processing = dirty(service, target.id)
  await new Promise<void>(resolve => setImmediate(resolve))
  t.notOk(service.cache.contact?.has(target.id), 'the target memory cache is invalidated immediately')
  t.notOk(notified, 'consumers wait for persistent deletion')
  t.same(service.cache.contact?.get(other.id), other)
  release()
  await processing
  t.ok(notified)
  t.same(persisted.get(other.id), other)
  await dirty(service, target.id)
  t.same(service.cache.contact?.get(other.id), other, 'repeated dirty remains scoped to the target')
})

test('contact dirty still clears memory when the persistent store is absent or rejects', async t => {
  const service = await fixture(operation => t.teardown(operation))
  const id = 'new-friend'
  service.cache.contact?.set(id, contact(id))
  setStore(service)
  await dirty(service, id)
  t.notOk(service.cache.contact?.has(id), 'a missing persistent store does not retain stale memory')

  const failure = new Error('contact cache unavailable')
  service.cache.contact?.set(id, contact(id))
  setStore(service, { delete: async () => { throw failure } })
  let emitted: unknown
  service.on('error', error => { emitted = error })
  await dirty(service, id)
  t.ok(emitted, 'the existing error event remains observable')
  t.notOk(service.cache.contact?.has(id), 'a persistent deletion failure does not retain stale memory')
})

test('contact dirty remains idempotent with the normal base invalidation listener', async t => {
  const service = await fixture(operation => t.teardown(operation))
  const id = 'new-friend'
  const room = { id: 'room', topic: '', adminIdList: [], memberIdList: [] }
  service.cache.contact?.set(id, contact(id))
  service.cache.room?.set(room.id, room)
  setStore(service, { delete: async () => {} })
  service.on('dirty', service.onDirty.bind(service))

  await dirty(service, id)
  await dirty(service, id)
  t.notOk(service.cache.contact?.has(id))
  t.same(service.cache.room?.get(room.id), room, 'contact invalidation does not affect room caches')
})
