#!/usr/bin/env -S node --no-warnings --loader ts-node/esm
/**
 * Regression tests for the RoomMember persistent-store dirty semantics.
 *
 * The persistent `PayloadStore.roomMember` is a
 * `FlashStore<roomId, {[memberId]: RoomMember}>` -- a per-room record of
 * members. Dirty ids arrive in two shapes:
 *
 *   1. A compound `"<roomId><STRING_SPLITTER><memberId>"` -- a single
 *      member's payload went stale (e.g. one member renamed).
 *   2. A bare `"<roomId>"` -- the whole room's member set went stale.
 *
 * The previous handler treated both shapes the same by calling
 * `roomMember.delete(roomId)`, which threw away the entire room's
 * cache even when only one member was dirty. That thrash forces the
 * next N-1 members to re-fetch over gRPC.
 *
 * The new handler must:
 *   - On compound id: drop only the named member, keep the rest.
 *   - On compound id whose split leaves the record empty: delete the row.
 *   - On bare roomId: delete the entire row (as before).
 */
import { test } from 'tstest'
import os from 'os'
import path from 'path'
import fs from 'fs'

import * as PUPPET from '@juzi/wechaty-puppet'

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

test('fastDirty(RoomMember, "<roomId>\\u001F<memberId>") drops only the named member', async t => {
  const { puppet, token } = await makePuppet()

  const roomId = 'room-test-id'
  await puppet._payloadStore.roomMember.set(roomId, {
    'member-A': { id: 'member-A', name: 'A' } as any,
    'member-B': { id: 'member-B', name: 'B' } as any,
  })

  await puppet.fastDirty({
    payloadType: PUPPET.types.Dirty.RoomMember,
    payloadId  : `${roomId}${PUPPET.STRING_SPLITTER}member-A`,
  })

  const after = await puppet._payloadStore.roomMember.get(roomId)
  t.ok(after, 'room entry must survive when only one member is dirtied')
  t.notOk(after && after['member-A'], 'dirtied member-A must be gone')
  t.ok(after && after['member-B'], 'unrelated member-B must be preserved')

  await cleanup(puppet, token)
})

test('fastDirty(RoomMember, "<roomId>\\u001F<lastMember>") deletes the row when empty', async t => {
  const { puppet, token } = await makePuppet()

  const roomId = 'room-test-id-lone'
  await puppet._payloadStore.roomMember.set(roomId, {
    'only-member': { id: 'only-member', name: 'Solo' } as any,
  })

  await puppet.fastDirty({
    payloadType: PUPPET.types.Dirty.RoomMember,
    payloadId  : `${roomId}${PUPPET.STRING_SPLITTER}only-member`,
  })

  const after = await puppet._payloadStore.roomMember.get(roomId)
  t.notOk(after, 'row must be deleted once the record has no members left')

  await cleanup(puppet, token)
})

test('fastDirty(RoomMember, "<roomId>") clears the whole room entry', async t => {
  const { puppet, token } = await makePuppet()

  const roomId = 'room-test-id-full'
  await puppet._payloadStore.roomMember.set(roomId, {
    'member-A': { id: 'member-A', name: 'A' } as any,
    'member-B': { id: 'member-B', name: 'B' } as any,
  })

  await puppet.fastDirty({
    payloadType: PUPPET.types.Dirty.RoomMember,
    payloadId  : roomId,
  })

  const after = await puppet._payloadStore.roomMember.get(roomId)
  t.notOk(after, 'bare roomId dirty must clear the whole row')

  await cleanup(puppet, token)
})

test('fastDirty(RoomMember) on unknown member is a no-op', async t => {
  const { puppet, token } = await makePuppet()

  const roomId = 'room-test-id-noop'
  const before = {
    'member-A': { id: 'member-A', name: 'A' } as any,
    'member-B': { id: 'member-B', name: 'B' } as any,
  }
  await puppet._payloadStore.roomMember.set(roomId, before)

  await puppet.fastDirty({
    payloadType: PUPPET.types.Dirty.RoomMember,
    payloadId  : `${roomId}${PUPPET.STRING_SPLITTER}ghost-member`,
  })

  const after = await puppet._payloadStore.roomMember.get(roomId)
  t.same(after, before, 'unrelated dirty must not disturb the record')

  await cleanup(puppet, token)
})
