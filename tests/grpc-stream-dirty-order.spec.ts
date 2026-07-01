#!/usr/bin/env -S node --no-warnings --loader ts-node/esm
/**
 * Regression / hardening test for the EVENT_TYPE_DIRTY dispatch order.
 *
 * Client-side dirty handling touches two independent caches:
 *
 *   - `fastDirty()` clears `_payloadStore` (FlashStore, on disk, async).
 *   - `emit('dirty')` triggers the puppet-side CacheMixin which clears
 *     the in-memory LRU synchronously in the same tick.
 *
 * If `emit('dirty')` runs before `fastDirty()` resolves, a listener that
 * immediately reads back the payload -- as CacheMixin.onDirty does when
 * a caller races with the dirty event -- can:
 *
 *   1. See an LRU miss (already cleared),
 *   2. Refetch via `contactRawPayload` etc.,
 *   3. Hit the still-un-cleared `_payloadStore` entry,
 *   4. Repopulate the LRU with the stale row that fastDirty is about
 *      to delete a microtask later,
 *   5. And the fresh fastDirty delete no-ops against a now-cold key.
 *
 * The current implementation `await`s fastDirty before emitting. This
 * test pins that invariant: fastDirty must fully resolve before any
 * `dirty` listener observes the event.
 */
import { test } from 'tstest'

import * as PUPPET from '@juzi/wechaty-puppet'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

import { PuppetService } from '../src/mod.js'

test('onGrpcStreamEvent awaits fastDirty before emitting dirty', async t => {
  const token = `puppet_service_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const puppet = new PuppetService({ token }) as any

  let fastDirtyResolvedAt: number | undefined
  let dirtyEmittedAt: number | undefined

  const FASTDIRTY_DELAY_MS = 50

  puppet.fastDirty = async (_payload: PUPPET.payloads.EventDirty) => {
    await new Promise(resolve => setTimeout(resolve, FASTDIRTY_DELAY_MS))
    fastDirtyResolvedAt = Date.now()
  }

  puppet.on('dirty', () => {
    dirtyEmittedAt = Date.now()
  })

  const dirtyJson = JSON.stringify({
    payloadType: PUPPET.types.Dirty.Contact,
    payloadId  : 'contact-x',
  })

  const fakeEvent = {
    getType   : () => grpcPuppet.EventType.EVENT_TYPE_DIRTY,
    getPayload: () => dirtyJson,
    getSeq    : () => 0,
  }

  await puppet.onGrpcStreamEvent(fakeEvent)

  t.ok(fastDirtyResolvedAt, 'fastDirty must have been invoked')
  t.ok(dirtyEmittedAt, 'dirty listener must have been invoked')
  t.ok(
    fastDirtyResolvedAt! <= dirtyEmittedAt!,
    `dirty emit (${dirtyEmittedAt}) must not precede fastDirty resolve (${fastDirtyResolvedAt})`,
  )
})
