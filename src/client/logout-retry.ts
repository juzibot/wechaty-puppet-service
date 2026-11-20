import { grpc } from '@juzi/wechaty-grpc'

import { captureRecoveryRequestContext } from './recovery.js'
import type { RecoveryRequestContext } from './recovery.js'

export interface LogoutRetryPolicy {
  /** Includes the first call; at most four attempts. */
  readonly maxAttempts?: number
  readonly intervalMilliseconds?: number
  /** One non-renewing budget, capped at 15 seconds and the caller's deadline. */
  readonly timeoutMilliseconds?: number
  /** Additional caller ownership, e.g. a runtime being drained. */
  readonly isCurrent?: () => boolean
}

function rejectedBeforeSubmission (error: unknown): boolean {
  const status = error as Partial<grpc.ServiceError> | undefined
  if (status?.code !== grpc.status.UNAVAILABLE || !status.metadata) { return false }
  const states = status.metadata.get('x-juzi-request-state')
  const capabilities = status.metadata.get('x-juzi-recovery-capability')
  return states.length === 1 && states[0] === 'not-submitted'
    && capabilities.length === 1 && capabilities[0] === 'admission-reject-v1'
}

/** Retry only a server's explicit pre-execution refusal, never an ambiguous transport failure. */
export async function retryLogout (
  operation: (context: RecoveryRequestContext) => Promise<void>,
  current: () => boolean,
  policy: LogoutRetryPolicy,
  onRetry: (attempt: number, error: unknown) => void,
  confirmed: () => boolean,
): Promise<void> {
  const maxAttempts = policy.maxAttempts ?? 4
  const interval = policy.intervalMilliseconds ?? 2000
  const timeout = policy.timeoutMilliseconds ?? 15_000
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4
    || !Number.isSafeInteger(interval) || interval < 1
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000) {
    throw new RangeError('Invalid logout retry limits')
  }
  const context = captureRecoveryRequestContext()
  const deadline = Math.min(Date.now() + timeout, context.deadline ?? Infinity)
  const cancelled = new AbortController()
  let failure: Error | undefined
  const cancel = (error: Error): void => { failure ??= error; cancelled.abort() }
  const check = (): Error | undefined => {
    if (confirmed()) { cancelled.abort(); return undefined }
    try {
      if (!current() || policy.isCurrent?.() === false) { cancel(new Error('Superseded logout request')) }
    } catch (error) { cancel(error instanceof Error ? error : new Error(String(error))) }
    if (Date.now() >= deadline) { cancel(new Error('Logout deadline exceeded')) }
    if (context.signals.some(signal => signal.aborted)) { cancel(new Error('Logout cancelled')) }
    return failure
  }
  const onAbort = (): void => cancel(new Error('Logout cancelled'))
  context.signals.forEach(signal => signal.addEventListener('abort', onAbort, { once: true }))
  // Also cancels an in-flight call when ownership changes with recovery disabled.
  const monitor = setInterval(check, 25)
  const expiry = setTimeout((): void => cancel(new Error('Logout deadline exceeded')), Math.max(1, deadline - Date.now()))
  try {
    for (let attempt = 1; ; attempt++) {
      const interrupted = check()
      if (confirmed()) { return }
      if (interrupted) { throw interrupted }
      try {
        await operation({ deadline, signal: cancelled.signal })
        return
      } catch (error) {
        if (confirmed()) { return }
        const cancelled = check()
        if (cancelled) { throw cancelled }
        if (attempt >= maxAttempts || !rejectedBeforeSubmission(error)) { throw error }
        onRetry(attempt, error)
      }
      await new Promise<void>((resolve, reject): void => {
        const finish = (): void => {
          clearTimeout(timer)
          cancelled.signal.removeEventListener('abort', abort)
          failure ? reject(failure) : resolve()
        }
        const abort = (): void => finish()
        const timer = setTimeout(finish, interval)
        cancelled.signal.addEventListener('abort', abort, { once: true })
        if (cancelled.signal.aborted) { finish() }
      })
    }
  } finally {
    clearInterval(monitor)
    clearTimeout(expiry)
    context.signals.forEach(signal => signal.removeEventListener('abort', onAbort))
  }
}
