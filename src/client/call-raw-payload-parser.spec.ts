#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { test }            from 'tstest'
import * as PUPPET         from '@juzi/wechaty-puppet'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

import { PuppetService }   from './puppet-service.js'
import { timestampFromMilliseconds } from '../pure-functions/timestamp.js'

/**
 * The parser only reads `rawPayload.*` and a module-level `log` — it never
 * touches `this`. Invoke it via `prototype.call({}, raw)` to avoid building a
 * full PuppetService instance for unit-level tests.
 */
const callParser = async (raw: grpcPuppet.CallPayloadResponse.AsObject) =>
  PuppetService.prototype.callRawPayloadParser.call({} as PuppetService, raw)

/**
 * 1. Full payload with starter, participants, media=VOICE, startTime, endTime
 *    parses every field, mapping VOICE -> CallMediaType.Audio.
 */
test('callRawPayloadParser parses a complete payload', async t => {
  const startMs = 1_700_000_000_000
  const endMs   = 1_700_000_030_000

  const pb = new grpcPuppet.CallPayloadResponse()
  pb.setId('call-1')
  pb.setStarter('alice')
  pb.setParticipantsList([ 'alice', 'bob' ])
  pb.setMedia(grpcPuppet.CallType.CALL_TYPE_VOICE)
  pb.setStartTime(timestampFromMilliseconds(startMs))
  pb.setEndTime(timestampFromMilliseconds(endMs))

  const payload = await callParser(pb.toObject())

  t.equal(payload.id, 'call-1', 'id propagated')
  t.equal(payload.starter, 'alice', 'starter propagated')
  t.same(payload.participants, [ 'alice', 'bob' ], 'participants propagated')
  t.equal(payload.media, PUPPET.types.CallMediaType.Audio, 'VOICE maps to Audio')
  t.equal(payload.startTime, startMs, 'startTime parsed')
  t.equal(payload.endTime, endMs, 'endTime parsed')
})

/**
 * 2. Empty starter string -> parser omits `starter` from the resulting payload.
 *    (Mirrors the server, which only `setStarter` when the value is truthy.)
 */
test('callRawPayloadParser omits starter when starter is an empty string', async t => {
  const pb = new grpcPuppet.CallPayloadResponse()
  pb.setId('call-2')
  pb.setParticipantsList([ 'alice' ])
  pb.setMedia(grpcPuppet.CallType.CALL_TYPE_VIDEO)
  pb.setStartTime(timestampFromMilliseconds(1_700_000_000_000))
  // no setStarter -> default proto3 string '' on the wire

  const payload = await callParser(pb.toObject())

  t.equal(payload.starter, undefined, 'starter is undefined when empty on the wire')
  t.equal(payload.media, PUPPET.types.CallMediaType.Video, 'VIDEO maps to Video')
})

/**
 * 3. endTime not set (no setEndTime) -> payload.endTime === undefined.
 */
test('callRawPayloadParser leaves endTime undefined when endTime is not set', async t => {
  const pb = new grpcPuppet.CallPayloadResponse()
  pb.setId('call-3')
  pb.setStarter('alice')
  pb.setParticipantsList([ 'alice', 'bob' ])
  pb.setMedia(grpcPuppet.CallType.CALL_TYPE_VOICE)
  pb.setStartTime(timestampFromMilliseconds(1_700_000_000_000))
  // no setEndTime

  const payload = await callParser(pb.toObject())

  t.equal(payload.endTime, undefined, 'endTime is undefined when not set on the wire')
})

/**
 * 4. media = CALL_TYPE_UNKNOWN -> throw, error mentions "media".
 */
test('callRawPayloadParser throws when media is CALL_TYPE_UNKNOWN', async t => {
  const pb = new grpcPuppet.CallPayloadResponse()
  pb.setId('call-4')
  pb.setParticipantsList([ 'alice' ])
  pb.setMedia(grpcPuppet.CallType.CALL_TYPE_UNKNOWN)
  pb.setStartTime(timestampFromMilliseconds(1_700_000_000_000))

  await t.rejects(
    callParser(pb.toObject()),
    /media/,
    'rejects with a message that mentions media',
  )
})

/**
 * 5. startTime not set -> throw, error mentions "startTime".
 */
test('callRawPayloadParser throws when startTime is not set', async t => {
  const pb = new grpcPuppet.CallPayloadResponse()
  pb.setId('call-5')
  pb.setParticipantsList([ 'alice' ])
  pb.setMedia(grpcPuppet.CallType.CALL_TYPE_VOICE)
  // no setStartTime

  await t.rejects(
    callParser(pb.toObject()),
    /startTime/,
    'rejects with a message that mentions startTime',
  )
})

/**
 * 6. endTime explicitly set to epoch 0 -> payload.endTime === 0.
 *    proto3 `setEndTime(timestamp(0))` is a legal "ended at epoch-0" value
 *    (extreme short session / test stub) and must not be swallowed by a
 *    truthy guard. Presence is what matters, not the numeric value.
 */
test('callRawPayloadParser preserves endTime when it is set to epoch zero', async t => {
  const pb = new grpcPuppet.CallPayloadResponse()
  pb.setId('call-6')
  pb.setStarter('alice')
  pb.setParticipantsList([ 'alice', 'bob' ])
  pb.setMedia(grpcPuppet.CallType.CALL_TYPE_VOICE)
  pb.setStartTime(timestampFromMilliseconds(1_700_000_000_000))
  pb.setEndTime(timestampFromMilliseconds(0))

  const payload = await callParser(pb.toObject())

  t.equal(payload.endTime, 0, 'endTime is 0 when explicitly set to epoch zero on the wire')
})
