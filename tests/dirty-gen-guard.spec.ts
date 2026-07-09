#!/usr/bin/env -S node --no-warnings --loader ts-node/esm
/**
 * Regression tests for the FlashStore write-back generation guard.
 *
 * `_payloadStore` (FlashStore, on disk) is a cache layer independent of
 * the puppet-side LRU. Before this fix it had no protection against the
 * "dirty lands during a raw fetch" race:
 *
 *   1. A raw fetch (e.g. `contactRawPayload`) starts a gRPC round-trip.
 *   2. An EVENT_TYPE_DIRTY arrives; `fastDirty` deletes the FlashStore row.
 *   3. The in-flight fetch resolves and writes the *pre-dirty* payload
 *      back into the FlashStore -- re-poisoning the row that was just
 *      cleared. The value then only refreshes after a *second* dirty.
 *
 * The fix snapshots a per-(type, id) generation counter before the raw
 * fetch and re-checks it with `isFreshWrite` before every FlashStore
 * write-back; the EVENT_TYPE_DIRTY handler bumps that counter before it
 * even awaits `fastDirty`, so the whole delete window is covered.
 */
import { test } from 'tstest'
import os from 'os'
import path from 'path'
import fs from 'fs'

import * as PUPPET from '@juzi/wechaty-puppet'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

import { PuppetService } from '../src/mod.js'

const makePuppet = async () => {
  const token = `puppet_service_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const puppet = new PuppetService({ token }) as any
  const accountId = 'acct-test'
  await puppet._payloadStore.start(accountId)
  return { puppet, token }
}

const cleanup = async (puppet: any, token: string) => {
  await puppet._payloadStore.stop()
  try {
    await fs.promises.rm(
      path.join(os.homedir(), '.wechaty', 'wechaty-puppet-service', token),
      { recursive: true, force: true },
    )
  } catch (_) { /* ignore */ }
}

/**
 * A one-shot gate for a fake gRPC method. The method resolves `entered`
 * as soon as it is invoked (by which point the caller's gen snapshot has
 * already been taken, since the snapshot precedes the fetch call), then
 * holds its callback until `release()` is called. This lets the test slot
 * a dirty deterministically between the fetch start (gen snapshot) and
 * the fetch resolution (write-back) -- no timers, no flakiness.
 */
const makeGate = () => {
  let release: () => void = () => {}
  let markEntered: () => void = () => {}
  const gate    = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  return { gate, entered, enter: () => markEntered(), release: () => release() }
}

test('contactRawPayload: a dirty mid-fetch skips the stale FlashStore write-back', async t => {
  const { puppet, token } = await makePuppet()

  const contactId = 'contact-race'
  const response = new grpcPuppet.ContactPayloadResponse()
  response.setId(contactId)
  response.setName('stale-name-from-inflight-fetch')

  const { gate, entered, enter, release } = makeGate()
  puppet._grpcManager = {
    client: {
      contactPayload: (_req: any, cb: (err: any, r: any) => void) => {
        enter()
        void (async () => {
          await gate
          cb(null, response)
        })()
      },
    },
  }

  // Start the fetch: it snapshots the gen, then blocks on the gate.
  const fetchPromise = puppet.contactRawPayload(contactId)
  // Deterministic: once the fake method is entered, the snapshot is taken.
  await entered

  // A dirty arrives while the fetch is in flight: bump gen + clear store,
  // exactly as the EVENT_TYPE_DIRTY handler does.
  puppet.cache.bumpGen(PUPPET.types.Dirty.Contact, contactId)
  await puppet.fastDirty({ payloadType: PUPPET.types.Dirty.Contact, payloadId: contactId })

  // Now let the stale fetch resolve into the write-back path.
  release()
  const returned = await fetchPromise

  t.equal(returned.id, contactId, 'raw fetch still returns its payload to the caller')
  const stored = await puppet._payloadStore.contact.get(contactId)
  t.notOk(stored, 'stale in-flight fetch must NOT re-poison the FlashStore after the dirty')

  await cleanup(puppet, token)
})

test('contactRawPayload: no dirty means the write-back proceeds as usual', async t => {
  const { puppet, token } = await makePuppet()

  const contactId = 'contact-happy'
  const response = new grpcPuppet.ContactPayloadResponse()
  response.setId(contactId)
  response.setName('fresh-name')

  puppet._grpcManager = {
    client: {
      contactPayload: (_req: any, cb: (err: any, r: any) => void) => cb(null, response),
    },
  }

  const returned = await puppet.contactRawPayload(contactId)
  t.equal(returned.id, contactId, 'raw fetch returns its payload')

  const stored = await puppet._payloadStore.contact.get(contactId)
  t.ok(stored, 'without a racing dirty the payload is written to the FlashStore')
  t.equal(stored && stored.id, contactId, 'stored payload matches the fetched id')

  await cleanup(puppet, token)
})

test('EVENT_TYPE_DIRTY bumps gen before awaiting fastDirty so pre-event snapshots are stale', async t => {
  const { puppet, token } = await makePuppet()

  const contactId = 'contact-bump'
  // A getter that snapshotted just before the event arrived.
  const snapshot = puppet.cache.snapshotGen(PUPPET.types.Dirty.Contact, contactId)

  const dirtyJson = JSON.stringify({
    payloadType: PUPPET.types.Dirty.Contact,
    payloadId  : contactId,
  })
  await puppet.onGrpcStreamEvent({
    getType   : () => grpcPuppet.EventType.EVENT_TYPE_DIRTY,
    getPayload: () => dirtyJson,
    getSeq    : () => 0,
  })

  t.notOk(
    puppet.cache.isFreshWrite(PUPPET.types.Dirty.Contact, contactId, snapshot),
    'a snapshot taken before the dirty event must be judged stale afterwards',
  )

  await cleanup(puppet, token)
})

test('EVENT_TYPE_DIRTY compound RoomMember bumps both the compound and the room-level gen', async t => {
  const { puppet, token } = await makePuppet()

  const roomId     = 'room-bump'
  const memberId   = 'member-bump'
  const compoundId = `${roomId}${PUPPET.STRING_SPLITTER}${memberId}`

  const compoundSnap = puppet.cache.snapshotGen(PUPPET.types.Dirty.RoomMember, compoundId)
  const roomSnap     = puppet.cache.snapshotGen(PUPPET.types.Dirty.RoomMember, roomId)

  const dirtyJson = JSON.stringify({
    payloadType: PUPPET.types.Dirty.RoomMember,
    payloadId  : compoundId,
  })
  await puppet.onGrpcStreamEvent({
    getType   : () => grpcPuppet.EventType.EVENT_TYPE_DIRTY,
    getPayload: () => dirtyJson,
    getSeq    : () => 0,
  })

  t.notOk(
    puppet.cache.isFreshWrite(PUPPET.types.Dirty.RoomMember, compoundId, compoundSnap),
    'the compound (roomId+SEP+memberId) key must be bumped',
  )
  t.notOk(
    puppet.cache.isFreshWrite(PUPPET.types.Dirty.RoomMember, roomId, roomSnap),
    'the bare room-level key must also be bumped so row-level write-backs are guarded',
  )

  await cleanup(puppet, token)
})

test('roomMemberRawPayload: a room-level dirty mid-fetch skips the row write-back', async t => {
  const { puppet, token } = await makePuppet()

  const roomId    = 'room-member-race'
  const contactId = 'member-race'

  const response = new grpcPuppet.RoomMemberPayloadResponse()
  response.setId(contactId)
  response.setName('stale-member-from-inflight-fetch')

  const { gate, entered, enter, release } = makeGate()
  puppet._grpcManager = {
    client: {
      roomMemberPayload: (_req: any, cb: (err: any, r: any) => void) => {
        enter()
        void (async () => {
          await gate
          cb(null, response)
        })()
      },
    },
  }

  // Start the fetch: it snapshots the room-level gen before reading the
  // row, then blocks on the gate.
  const fetchPromise = puppet.roomMemberRawPayload(roomId, contactId)
  await entered

  // A bare-roomId dirty lands mid-fetch: the whole member set is stale.
  puppet.cache.bumpGen(PUPPET.types.Dirty.RoomMember, roomId)
  await puppet.fastDirty({ payloadType: PUPPET.types.Dirty.RoomMember, payloadId: roomId })

  release()
  const returned = await fetchPromise

  t.equal(returned.id, contactId, 'raw fetch still returns its member payload to the caller')
  const stored = await puppet._payloadStore.roomMember.get(roomId)
  t.notOk(stored, 'stale in-flight member fetch must NOT re-create the row after the dirty')

  await cleanup(puppet, token)
})
