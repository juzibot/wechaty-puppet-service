#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { test } from 'tstest'

import * as PUPPET              from '@juzi/wechaty-puppet'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

import {
  puppetCallMediaTypeToGrpc,
  grpcCallTypeToPuppetMedia,
} from './call-media-mapping.js'

/**
 * 1. CallMediaType Audio and Video round-trip: PUPPET -> gRPC -> PUPPET === original.
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
 * 2. Each direction maps to the expected concrete enum member.
 */
test('puppetCallMediaTypeToGrpc: Audio -> VOICE, Video -> VIDEO', async t => {
  t.equal(puppetCallMediaTypeToGrpc(PUPPET.types.CallMediaType.Audio), grpcPuppet.CallType.CALL_TYPE_VOICE, 'Audio maps to CALL_TYPE_VOICE')
  t.equal(puppetCallMediaTypeToGrpc(PUPPET.types.CallMediaType.Video), grpcPuppet.CallType.CALL_TYPE_VIDEO, 'Video maps to CALL_TYPE_VIDEO')
})

/**
 * 3. CALL_TYPE_UNKNOWN (wire zero value) maps to undefined so callers can reject it explicitly.
 */
test('grpcCallTypeToPuppetMedia: CALL_TYPE_UNKNOWN returns undefined', async t => {
  const result = grpcCallTypeToPuppetMedia(grpcPuppet.CallType.CALL_TYPE_UNKNOWN)
  t.equal(result, undefined, 'CALL_TYPE_UNKNOWN should map to undefined')
})

/**
 * 4. Unknown numeric values not in the proto enum throw rather than silently returning garbage.
 */
test('grpcCallTypeToPuppetMedia: unknown value 999 throws', async t => {
  t.throws(
    () => grpcCallTypeToPuppetMedia(999),
    'should throw for unknown CallType value 999',
  )
})
