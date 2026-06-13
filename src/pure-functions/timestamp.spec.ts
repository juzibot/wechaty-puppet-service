#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { test } from 'tstest'

import {
  millisecondsFromTimestamp,
  millisecondsFromTimestampObject,
  timestampFromMilliseconds,
}                             from './timestamp.js'

/**
 * 1. ms -> Timestamp -> ms round-trips for millisecond-aligned values.
 */
test('timestampFromMilliseconds <-> millisecondsFromTimestamp round-trip', async t => {
  const cases = [
    0,
    1_000,
    1_700_000_000_000,
    1_700_000_000_123,
  ]

  for (const ms of cases) {
    const roundTripped = millisecondsFromTimestamp(timestampFromMilliseconds(ms))
    t.equal(roundTripped, ms, `round-trip identity for ${ms}ms`)
  }
})

/**
 * 2. The plain-object variant agrees with the instance variant for the same
 *    Timestamp (this is the `toObject()` shape used by callRawPayloadParser).
 */
test('millisecondsFromTimestampObject matches millisecondsFromTimestamp', async t => {
  const cases = [
    0,
    1_000,
    1_700_000_000_123,
  ]

  for (const ms of cases) {
    const timestamp = timestampFromMilliseconds(ms)
    const fromInstance = millisecondsFromTimestamp(timestamp)
    const fromObject   = millisecondsFromTimestampObject(timestamp.toObject())
    t.equal(fromObject, fromInstance, `instance and object conversion agree for ${ms}ms`)
  }
})

/**
 * 3. Sub-millisecond nanos are rounded to the nearest millisecond.
 */
test('millisecondsFromTimestampObject rounds nanos to nearest millisecond', async t => {
  t.equal(millisecondsFromTimestampObject({ seconds: 1, nanos: 0 }),         1000, 'no nanos')
  t.equal(millisecondsFromTimestampObject({ seconds: 1, nanos: 499_999 }),   1000, '0.499ms rounds down')
  t.equal(millisecondsFromTimestampObject({ seconds: 1, nanos: 500_000 }),   1001, '0.5ms rounds up')
  t.equal(millisecondsFromTimestampObject({ seconds: 1, nanos: 999_999 }),   1001, '0.999ms rounds up')
  t.equal(millisecondsFromTimestampObject({ seconds: 0, nanos: 123_000_000 }), 123, '123ms from nanos')
})
