#!/usr/bin/env -S node --no-warnings --loader ts-node/esm
/**
 * Regression test for the double JSON.parse on every EVENT_TYPE_DIRTY
 * stream event.
 *
 * The previous implementation was:
 *
 *   case grpcPuppet.EventType.EVENT_TYPE_DIRTY:
 *     await this.fastDirty(JSON.parse(payload))
 *     this.emit('dirty', JSON.parse(payload) as PUPPET.payloads.EventDirty)
 *
 * which parses the same JSON string twice for every dirty event on the
 * hot stream path. Parse the payload once and reuse the resulting object.
 */
import { test, sinon } from 'tstest'

import * as PUPPET from '@juzi/wechaty-puppet'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

import { PuppetService } from '../src/mod.js'

test('onGrpcStreamEvent must parse a DIRTY payload only once', async t => {
  const token = `puppet_service_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const puppet = new PuppetService({ token }) as any

  // Force the fastDirty branch to be a no-op so we measure only the
  // parsing cost in the dispatch case.
  puppet.fastDirty = async (_: any) => {}

  const dirtyPayload = JSON.stringify({
    payloadType: PUPPET.types.Dirty.Contact,
    payloadId  : 'x',
  })

  // Build a minimal grpcPuppet.EventResponse shape -- only the getters
  // touched by `onGrpcStreamEvent` are needed.
  const fakeEvent = {
    getType   : () => grpcPuppet.EventType.EVENT_TYPE_DIRTY,
    getPayload: () => dirtyPayload,
    getSeq    : () => 0,
  }

  const parseSpy = sinon.spy(JSON, 'parse')
  try {
    const baseline = parseSpy.callCount
    await puppet.onGrpcStreamEvent(fakeEvent)
    const delta = parseSpy.callCount - baseline
    t.equal(
      delta,
      1,
      `EVENT_TYPE_DIRTY should JSON.parse(payload) only once, observed ${delta}`,
    )
  } finally {
    parseSpy.restore()
  }
})
