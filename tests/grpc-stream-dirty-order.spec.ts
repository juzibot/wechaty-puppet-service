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
import { test, sinon } from 'tstest'

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

test('onGrpcStreamEvent: dirty emit sequence-number is strictly after every fastDirty resolution', async t => {
  // Wall-clock ordering (the baseline test above) is fine as a smoke
  // signal but can collapse to a tie when both boundaries fall inside
  // the same millisecond. The invariant we actually care about is
  // *causal*: each fastDirty must have fully resolved before the
  // corresponding dirty emit fires. Record call ordinals from a shared
  // monotonic counter to pin that -- ordinals cannot tie.
  const token = `puppet_service_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const puppet = new PuppetService({ token }) as any

  let sequence = 0
  const nextOrdinal = () => ++sequence

  // Order of interest per event: fastDirty enter -> fastDirty resolve -> dirty emit.
  const fastDirtyEnterOrdinals: number[] = []
  const fastDirtyResolveOrdinals: number[] = []
  const dirtyEmitOrdinals: number[] = []

  const fastDirtyStub = sinon.stub().callsFake(async (_payload: PUPPET.payloads.EventDirty) => {
    fastDirtyEnterOrdinals.push(nextOrdinal())
    // Yield the microtask queue so a broken ordering would surface: if
    // emit ran ahead of the await point below, its ordinal would slot
    // between our enter and resolve records.
    await new Promise(resolve => setImmediate(resolve))
    fastDirtyResolveOrdinals.push(nextOrdinal())
  })
  puppet.fastDirty = fastDirtyStub

  const dirtySpy = sinon.spy(() => {
    dirtyEmitOrdinals.push(nextOrdinal())
  })
  puppet.on('dirty', dirtySpy)

  const makeEvent = (payloadId: string) => {
    const dirtyJson = JSON.stringify({
      payloadType: PUPPET.types.Dirty.Contact,
      payloadId,
    })
    return {
      getType   : () => grpcPuppet.EventType.EVENT_TYPE_DIRTY,
      getPayload: () => dirtyJson,
      getSeq    : () => 0,
    }
  }

  // Two back-to-back dirty events: this is the scenario Fix #6 pins,
  // sequential await must hold across both.
  await puppet.onGrpcStreamEvent(makeEvent('contact-1'))
  await puppet.onGrpcStreamEvent(makeEvent('contact-2'))

  t.equal(fastDirtyStub.callCount, 2, 'fastDirty invoked once per dirty event')
  t.equal(dirtySpy.callCount, 2, 'dirty listener invoked once per dirty event')
  t.equal(fastDirtyEnterOrdinals.length, 2, 'both fastDirty invocations recorded an entry ordinal')
  t.equal(fastDirtyResolveOrdinals.length, 2, 'both fastDirty invocations recorded a resolve ordinal')
  t.equal(dirtyEmitOrdinals.length, 2, 'both dirty emits recorded an ordinal')

  for (let i = 0; i < 2; i++) {
    t.ok(
      fastDirtyEnterOrdinals[i]! < fastDirtyResolveOrdinals[i]!,
      `event #${i}: fastDirty must enter (ord=${fastDirtyEnterOrdinals[i]}) before it resolves (ord=${fastDirtyResolveOrdinals[i]})`,
    )
    t.ok(
      fastDirtyResolveOrdinals[i]! < dirtyEmitOrdinals[i]!,
      `event #${i}: dirty emit ordinal (${dirtyEmitOrdinals[i]}) must strictly follow fastDirty resolve ordinal (${fastDirtyResolveOrdinals[i]})`,
    )
  }
})
