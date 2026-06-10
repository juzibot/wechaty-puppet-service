#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { test } from 'tstest'

import * as PUPPET              from '@juzi/wechaty-puppet'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

import {
  puppetCallSignalToGrpc,
  grpcCallSignalToPuppet,
  puppetCallMediaTypeToGrpc,
  grpcCallTypeToPuppetMedia,
} from './call-signal-mapping.js'

/**
 * 1. All 6 CallSignal members round-trip: PUPPET -> gRPC -> PUPPET === original.
 *    Using Object.values so any future enum additions are automatically covered.
 */
test('CallSignal: all members survive a round-trip through gRPC', async t => {
  for (const signal of Object.values(PUPPET.types.CallSignal)) {
    const grpcValue   = puppetCallSignalToGrpc(signal)
    const roundTripped = grpcCallSignalToPuppet(grpcValue)
    t.equal(roundTripped, signal, `round-trip should be identity for CallSignal.${signal}`)
  }
})

/**
 * 2. CallMediaType Audio and Video round-trip correctly.
 */
test('CallMediaType: Audio and Video survive a round-trip through gRPC', async t => {
  const mediaCases = [
    PUPPET.types.CallMediaType.Audio,
    PUPPET.types.CallMediaType.Video,
  ] as const

  for (const media of mediaCases) {
    const grpcValue    = puppetCallMediaTypeToGrpc(media)
    const roundTripped = grpcCallTypeToPuppetMedia(grpcValue)
    t.equal(roundTripped, media, `round-trip should be identity for CallMediaType.${media}`)
  }
})

/**
 * 3. CALL_TYPE_UNKNOWN (wire zero value) maps to undefined.
 */
test('grpcCallTypeToPuppetMedia: CALL_TYPE_UNKNOWN returns undefined', async t => {
  const result = grpcCallTypeToPuppetMedia(grpcPuppet.CallType.CALL_TYPE_UNKNOWN)
  t.equal(result, undefined, 'CALL_TYPE_UNKNOWN should map to undefined')
})

/**
 * 4. gRPC zero value CALL_SIGNAL_UNSPECIFIED (0) has no PUPPET counterpart — must throw.
 */
test('grpcCallSignalToPuppet: CALL_SIGNAL_UNSPECIFIED (0) throws', async t => {
  t.throws(
    () => grpcCallSignalToPuppet(grpcPuppet.CallSignal.CALL_SIGNAL_UNSPECIFIED),
    'should throw for wire zero value CALL_SIGNAL_UNSPECIFIED',
  )
})

/**
 * 5. Unknown numeric values not in the proto enum throw rather than silently returning garbage.
 */
test('grpcCallSignalToPuppet: unknown value 999 throws', async t => {
  t.throws(
    () => grpcCallSignalToPuppet(999),
    'should throw for unknown CallSignal value 999',
  )
})

test('grpcCallTypeToPuppetMedia: unknown value 999 throws', async t => {
  t.throws(
    () => grpcCallTypeToPuppetMedia(999),
    'should throw for unknown CallType value 999',
  )
})
