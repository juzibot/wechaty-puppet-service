import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'

import { grpc } from '@juzi/wechaty-grpc'
import { test, sinon } from 'tstest'

import { retryLogout } from './logout-retry.js'
import { withRecoveryRequestContext } from './recovery.js'
import type { RecoveryRequestContext } from './recovery.js'

function refusal (states = [ 'not-submitted' ], capabilities = [ 'admission-reject-v1' ], code = grpc.status.UNAVAILABLE): grpc.ServiceError {
  const metadata = new grpc.Metadata()
  states.forEach(value => metadata.add('x-juzi-request-state', value))
  capabilities.forEach(value => metadata.add('x-juzi-recovery-capability', value))
  return Object.assign(new Error('not admitted'), { code, details: 'not admitted', metadata })
}

const current = (): boolean => true
const unconfirmed = (): boolean => false
const ignoreRetry = (): void => {}

test('logout retries default to two-second spacing and four total attempts', async t => {
  const clock = sinon.useFakeTimers({ now: 1000 })
  const error = refusal()
  const times: number[] = []
  const retries: number[] = []
  try {
    const result = retryLogout(async (): Promise<void> => { times.push(Date.now()); throw error }, current, {},
      attempt => { retries.push(attempt) }, unconfirmed).catch((failure: unknown) => failure)
    await clock.tickAsync(1999)
    assert.deepEqual(times, [ 1000 ])
    await clock.tickAsync(1)
    assert.deepEqual(times, [ 1000, 3000 ])
    await clock.tickAsync(4000)
    assert.equal(await result, error)
    assert.deepEqual(times, [ 1000, 3000, 5000, 7000 ])
    assert.deepEqual(retries, [ 1, 2, 3 ])
    assert.equal(clock.countTimers(), 0)
    t.pass('the initial call counts toward the limit and waiting never renews it')
  } finally { clock.restore() }
})

test('logout never replays ambiguous or malformed refusal metadata', async t => {
  const errors = [
    new Error('connection lost after execution'),
    refusal([], []),
    refusal([ 'not-submitted' ], []),
    refusal([], [ 'admission-reject-v1' ]),
    refusal([ 'submitted' ]),
    refusal([ 'not-submitted' ], [ 'unknown' ]),
    refusal([ 'not-submitted', 'not-submitted' ]),
    refusal([ 'not-submitted' ], [ 'admission-reject-v1', 'admission-reject-v1' ]),
    refusal(undefined, undefined, grpc.status.INTERNAL),
    refusal(undefined, undefined, grpc.status.DEADLINE_EXCEEDED),
  ]
  for (const error of errors) {
    let calls = 0
    await assert.rejects(retryLogout(async (): Promise<void> => { calls++; throw error }, current,
      { intervalMilliseconds: 1, timeoutMilliseconds: 20 }, ignoreRetry, unconfirmed), failure => failure === error)
    assert.equal(calls, 1, error.message)
  }
  t.pass('one exact state and capability are required; error text and generic status codes are insufficient')
})

test('logout has one fifteen-second budget even when the RPC never acknowledges', async t => {
  const clock = sinon.useFakeTimers({ now: 1000 })
  let calls = 0
  let settled = false
  let request: RecoveryRequestContext | undefined
  try {
    const result = retryLogout(async context => {
      calls++; request = context
      await new Promise<void>((_resolve, reject): void => {
        context.signal!.addEventListener('abort', (): void => { reject(new Error('RPC cancelled')) }, { once: true })
      })
    }, current, {}, ignoreRetry, unconfirmed).catch((error: unknown) => { settled = true; return error })
    await clock.tickAsync(14_999)
    assert.equal(settled, false)
    assert.equal(request?.deadline, 16_000)
    await clock.tickAsync(1)
    assert.match(String(await result), /deadline/i)
    assert.equal(calls, 1, 'a missing acknowledgement is never replayed')
    assert.equal(request.signal?.aborted, true)
    assert.equal(clock.countTimers(), 0)
    t.pass('the total budget cancels the in-flight call and releases every timer')
  } finally { clock.restore() }
})

test('nested caller contexts retain their shortest deadline and all cancellation signals', async t => {
  const clock = sinon.useFakeTimers({ now: 1000 })
  const outer = new AbortController()
  const inner = new AbortController()
  let request: RecoveryRequestContext | undefined
  let calls = 0
  try {
    const result = withRecoveryRequestContext({ deadline: 1100, signal: outer.signal }, () =>
      withRecoveryRequestContext({ deadline: 1200, signal: inner.signal }, () =>
        retryLogout(async context => { request = context; calls++; throw refusal() }, current, {}, ignoreRetry, unconfirmed)))
      .catch((error: unknown) => error)
    await clock.tickAsync(0)
    assert.equal(request?.deadline, 1100)
    assert.equal(getEventListeners(outer.signal, 'abort').length, 1)
    assert.equal(getEventListeners(inner.signal, 'abort').length, 1)
    outer.abort()
    assert.match(String(await result), /cancel/i)
    assert.equal(calls, 1)
    assert.equal(getEventListeners(outer.signal, 'abort').length, 0)
    assert.equal(getEventListeners(inner.signal, 'abort').length, 0)
    assert.equal(clock.countTimers(), 0)
    t.pass('cancelling an enclosing request interrupts a pending retry without leaking listeners')
  } finally { clock.restore() }
})

test('expired or already cancelled contexts never submit a logout attempt', async t => {
  const cancelled = new AbortController(); cancelled.abort()
  for (const context of [ { signal: cancelled.signal }, { deadline: Date.now() - 1 } ]) {
    let calls = 0
    await assert.rejects(withRecoveryRequestContext(context, () =>
      retryLogout(async (): Promise<void> => { calls++ }, current, {}, ignoreRetry, unconfirmed)), /cancel|deadline/i)
    assert.equal(calls, 0)
  }
  t.pass('a caller context is checked before the first submission')
})

test('logout validates limits before starting any attempt', async t => {
  for (const policy of [
    { maxAttempts: 0 }, { maxAttempts: 5 }, { maxAttempts: 1.5 },
    { intervalMilliseconds: 0 }, { intervalMilliseconds: Infinity },
    { timeoutMilliseconds: 0 }, { timeoutMilliseconds: 15_001 },
  ]) {
    let calls = 0
    await assert.rejects(retryLogout(async (): Promise<void> => { calls++ }, current, policy, ignoreRetry, unconfirmed), RangeError)
    assert.equal(calls, 0)
  }
  t.pass('invalid limits cannot silently expand the retry budget')
})

test('successful logout removes timers and caller abort listeners', async t => {
  const clock = sinon.useFakeTimers({ now: 1000 })
  const caller = new AbortController()
  try {
    await withRecoveryRequestContext({ signal: caller.signal }, () =>
      retryLogout(async (): Promise<void> => {}, current, {}, ignoreRetry, unconfirmed))
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
    assert.equal(clock.countTimers(), 0)
    t.pass('initial success leaves no work that can fire after completion')
  } finally { clock.restore() }
})

test('the caller deadline ends retry waiting instead of renewing on each attempt', async t => {
  const clock = sinon.useFakeTimers({ now: 1000 })
  let calls = 0
  try {
    const result = withRecoveryRequestContext({ deadline: 3500 }, () =>
      retryLogout(async (): Promise<void> => { calls++; throw refusal() }, current, {}, ignoreRetry, unconfirmed))
      .catch((error: unknown) => error)
    await clock.tickAsync(2000)
    assert.equal(calls, 2)
    await clock.tickAsync(500)
    assert.match(String(await result), /deadline/i)
    assert.equal(calls, 2)
    assert.equal(clock.countTimers(), 0)
    t.pass('the retry interval never extends the original caller budget')
  } finally { clock.restore() }
})
