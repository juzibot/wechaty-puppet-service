#!/usr/bin/env -S node --no-warnings --loader ts-node/esm
/**
 * Regression test for the RoomMember persistent-store dirty bug.
 *
 * The puppet-side cache mixin already knows that RoomMember dirty ids are
 * sometimes a compound `"<roomId><memberId>"` (using STRING_SPLITTER)
 * and splits the id before deleting from the in-memory LRU
 * (wechaty-puppet/src/mixins/cache-mixin.ts).
 *
 * However the client-side `fastDirty` here passes the raw id straight to
 * `PayloadStore.roomMember.delete`. The persistent FlashStore is keyed by
 * roomId only, so the delete silently no-ops and the stale entry survives
 * across process restarts.
 *
 * This test populates the store, fires the dirty path with a compound id,
 * and asserts the entry is gone.
 */
import { test } from 'tstest'
import os from 'os'
import path from 'path'
import fs from 'fs'

import * as PUPPET from '@juzi/wechaty-puppet'

import { PuppetService } from '../src/mod.js'

test('fastDirty(RoomMember, "<roomId>\\u001F<memberId>") must clear the room entry', async t => {
  const token = `puppet_service_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const puppet = new PuppetService({ token }) as any

  const accountId = 'acct-test'
  await puppet._payloadStore.start(accountId)

  const roomId = 'room-test-id'
  await puppet._payloadStore.roomMember.set(roomId, {
    'member-A': { id: 'member-A', name: 'A' } as any,
    'member-B': { id: 'member-B', name: 'B' } as any,
  })

  const before = await puppet._payloadStore.roomMember.get(roomId)
  t.ok(before, 'sanity: roomMember entry exists before dirty')

  await puppet.fastDirty({
    payloadType: PUPPET.types.Dirty.RoomMember,
    payloadId  : `${roomId}${PUPPET.STRING_SPLITTER}member-A`,
  })

  const after = await puppet._payloadStore.roomMember.get(roomId)
  t.notOk(after, 'roomMember entry must be cleared after compound-id dirty')

  await puppet._payloadStore.stop()

  // best-effort cleanup of the on-disk store dir
  try {
    await fs.promises.rm(
      path.join(os.homedir(), '.wechaty', 'wechaty-puppet-service', token),
      { recursive: true, force: true },
    )
  } catch (_) { /* ignore */ }
})
