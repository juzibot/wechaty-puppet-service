import { AsyncLocalStorage } from 'node:async_hooks'

import { grpc, puppet } from '@juzi/wechaty-grpc'

import { AdmissionRetryCall } from './admission-retry-call.js'

export interface RecoveryOptions {
  readonly enabled: boolean
  readonly maxRecoveryMilliseconds?: number
  readonly inactivityMilliseconds?: number
  readonly maxPendingRequests?: number
  readonly maxPendingBytes?: number
  readonly controlTimeoutMilliseconds?: number
}

export interface RecoveryRequestContext {
  /** Absolute Unix time in milliseconds, not a relative timeout. */
  readonly deadline?: number
  readonly signal?: AbortSignal
}

export type RecoveryState =
  | { readonly status: 'disabled' | 'ready' }
  | { readonly status: 'recovering', readonly deadline: number }
  | { readonly status: 'offline', readonly reason: string }

interface EventContext { readonly current: () => boolean }
interface RequestContext extends RecoveryRequestContext { readonly signals?: readonly AbortSignal[] }
interface PendingMessage { readonly message: unknown, readonly next: (message: unknown) => void }
interface AdmissionFence {
  readonly current: () => boolean
  readonly retrySignal?: AbortSignal
}

class AdmissionError extends Error {

  readonly code = grpc.status.RESOURCE_EXHAUSTED

}

function signalsOf (context: RequestContext): readonly AbortSignal[] {
  return [ ...new Set([ ...(context.signals ?? []), ...(context.signal ? [ context.signal ] : []) ]) ]
}

const requests = new AsyncLocalStorage<RequestContext>()
const events = new AsyncLocalStorage<EventContext>()
const controls = new Set([ 'Event', 'Start', 'Stop', 'Logout', 'Ding', 'EnterVerifyCode', 'CancelVerifyCode', 'RefreshQRCode', 'EnterVerifySlide', 'EnterSameNetVerify' ])
// Only side-effect-free reads required by login/cache invalidation/replay listeners.
const replayReads = new Set([
  'CurrentUser', 'Version', 'ContactPayload', 'BatchContactPayload', 'ContactList',
  'RoomPayload', 'BatchRoomPayload', 'RoomList', 'RoomMemberPayload', 'BatchRoomMemberPayload',
  'RoomMemberList', 'MessagePayload', 'CallPayload',
  'FriendshipPayload', 'RoomInvitationPayload', 'TagPayload', 'TagGroupPayload', 'TagGroupList',
  'TagGroupTagList', 'TagTagList', 'TagContactTagList', 'TagTagContactList', 'postPayload',
  'postPayloadSayable', 'OrgBroadcastPayload',
])

export function withRecoveryRequestContext<Result> (context: RecoveryRequestContext, operation: () => Result): Result {
  if (context.deadline !== undefined && !Number.isFinite(context.deadline)) {
    throw new RangeError('Request deadline must be an absolute finite Unix timestamp in milliseconds')
  }
  const parent = requests.getStore()
  const deadline = Math.min(context.deadline ?? Infinity, parent?.deadline ?? Infinity)
  // Store source signals, not a composed signal: each RPC owns and releases its listeners.
  const signals = signalsOf({ signals: parent ? signalsOf(parent) : [], signal: context.signal })
  return requests.run({ deadline, signals }, operation)
}

export class RecoveryGate {

  private value: RecoveryState
  private accountId?: string
  private loggedIn = false
  private isReady = false
  private replayComplete = false
  private timer?: NodeJS.Timeout
  private readonly listeners = new Set<() => void>()
  readonly budget: number
  readonly inactivity: number
  private readonly maxPendingRequests: number
  private readonly maxPendingBytes: number
  private readonly controlTimeout: number
  private pendingRequests = 0
  private pendingBytes = 0
  private controls = new AbortController()
  private admissionEpoch = 0
  private admissionRetries = new AbortController()

  constructor (readonly options?: RecoveryOptions, private readonly onExpired?: () => void, private readonly onUnsubmitted?: () => boolean) {
    this.budget = options?.maxRecoveryMilliseconds ?? 300_000
    this.inactivity = options?.inactivityMilliseconds ?? 45_000
    this.maxPendingRequests = options?.maxPendingRequests ?? 256
    this.maxPendingBytes = options?.maxPendingBytes ?? 8 * 1024 * 1024
    this.controlTimeout = options?.controlTimeoutMilliseconds ?? 10_000
    if (![ this.maxPendingRequests, this.maxPendingBytes, this.controlTimeout ].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('Invalid recovery admission limits or control timeout')
    }
    if (!Number.isFinite(this.budget) || this.budget <= 0 || this.budget > 300_000
      || !Number.isFinite(this.inactivity) || this.inactivity <= 0) {
      throw new Error('Invalid recovery budget or inactivity timeout')
    }
    this.value = options?.enabled ? { status: 'offline', reason: 'Not started' } : { status: 'disabled' }
  }

  get state (): RecoveryState { return this.value }
  get enabled (): boolean { return this.options?.enabled === true }

  begin (accountId?: string, newSession = false): void {
    if (!this.enabled) { return }
    if (newSession) {
      this.admissionEpoch++
      this.admissionRetries.abort()
      this.admissionRetries = new AbortController()
      this.replaceControls()
      clearTimeout(this.timer)
      this.value = { status: 'offline', reason: 'New session' }
      this.notify()
    }
    this.accountId = newSession ? accountId : this.accountId ?? accountId
    this.loggedIn = false
    this.isReady = false
    this.replayComplete = false
    if (this.value.status === 'recovering') { return }
    this.value = { status: 'recovering', deadline: Date.now() + this.budget }
    this.timer = setTimeout((): void => {
      this.fail('Recovery budget exhausted')
      this.onExpired?.()
    }, this.budget)
  }

  login (accountId: string): void {
    if (!this.checkAccount(accountId) || this.value.status !== 'recovering') { return }
    this.accountId = accountId
    this.loggedIn = true
    this.complete()
  }

  checkAccount (accountId: string): boolean {
    if (typeof accountId !== 'string' || !accountId) {
      this.fail('Invalid login account')
      return false
    }
    if (this.accountId && this.accountId !== accountId) {
      this.fail('Account changed during recovery')
      return false
    }
    return true
  }

  ready (): void { this.isReady = true; this.complete() }
  barrier (accountId: string): void {
    if (!this.loggedIn || accountId !== this.accountId) {
      this.fail('Replay barrier account mismatch or missing login')
      return
    }
    this.replayComplete = true
    this.complete()
  }

  private complete (): void {
    if (this.value.status !== 'recovering' || !this.loggedIn || !this.isReady || !this.replayComplete) { return }
    if (Date.now() >= this.value.deadline) {
      this.fail('Recovery budget exhausted')
      this.onExpired?.()
      return
    }
    clearTimeout(this.timer)
    this.value = { status: 'ready' }
    this.notify()
  }

  fail (reason: string): void {
    if (!this.enabled) { return }
    this.admissionEpoch++
    clearTimeout(this.timer)
    this.value = { status: 'offline', reason }
    this.notify()
    this.replaceControls()
  }

  replaceControls (): void {
    const previous = this.controls
    this.controls = new AbortController()
    previous.abort()
  }

  private notify (): void { for (const listener of this.listeners) { listener() } }

  runEvent<Result> (current: () => boolean, operation: () => Result): Result {
    return events.run({ current }, operation)
  }

  runDetached<Result> (operation: () => Result): Result {
    return requests.run({}, (): Result => events.exit(operation))
  }

  stopAdmissionRetries (): void { this.admissionRetries.abort() }

  private async waitForAttempt (notBefore: number, deadline: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject): void => {
      let timer: NodeJS.Timeout | undefined
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', check)
        error ? reject(error) : resolve()
      }
      const check = (): void => {
        if (signal.aborted) { finish(new Error('Request cancelled')); return }
        const now = Date.now()
        if (now >= deadline) { finish(new Error('Request deadline exceeded')); return }
        if (now >= notBefore) { finish(); return }
        timer = setTimeout(check, Math.max(1, Math.min(notBefore, deadline) - now))
      }
      signal.addEventListener('abort', check, { once: true })
      check()
    })
  }

  async wait (context: RequestContext = requests.getStore() ?? {}, bypass = false): Promise<void> {
    await new Promise<void>((resolve, reject): void => {
      const signals = signalsOf(context)
      let timer: NodeJS.Timeout | undefined
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        this.listeners.delete(check)
        for (const signal of signals) { signal.removeEventListener('abort', check) }
        error ? reject(error) : resolve()
      }
      const check = (): void => {
        if (signals.some(signal => signal.aborted)) { finish(new Error('Request cancelled')); return }
        if (Date.now() >= (context.deadline ?? Infinity)) { finish(new Error('Request deadline exceeded')); return }
        if (bypass || this.value.status === 'ready' || this.value.status === 'disabled') { finish(); return }
        if (this.value.status === 'offline') { finish(new Error(this.value.reason)); return }
        // Timers may wake before the wall-clock deadline (including clock adjustments).
        clearTimeout(timer)
        if (Number.isFinite(context.deadline)) { timer = setTimeout(check, Math.max(1, context.deadline! - Date.now())) }
      }
      if (!bypass && this.listeners.size >= this.maxPendingRequests) { reject(new AdmissionError('Recovery request capacity exhausted')); return }
      if (!bypass) { this.listeners.add(check) }
      for (const signal of signals) { signal.addEventListener('abort', check, { once: true }) }
      check()
    })
  }

  readonly interceptor: grpc.Interceptor = (options, nextCall) => {
    const context = requests.getStore() ?? {}
    const event = events.getStore()
    const method = options.method_definition.path.split('/').pop() ?? ''
    const generatedUnary = Object.values(puppet.PuppetService).some(definition =>
      definition.path === options.method_definition.path
      && definition.responseDeserialize === options.method_definition.responseDeserialize
      && definition.requestSerialize === options.method_definition.requestSerialize,
    )
    if (!this.enabled || controls.has(method) || options.method_definition.requestStream
      || options.method_definition.responseStream || !generatedUnary) {
      return this.interceptAttempt(options, nextCall, context, event)
    }
    const epoch = this.admissionEpoch
    const deadline = Math.min(
      context.deadline ?? Infinity,
      options.deadline instanceof Date ? options.deadline.getTime() : options.deadline ?? Infinity,
      event && replayReads.has(method) ? Date.now() + this.controlTimeout : Infinity,
    )
    const current = (): boolean => epoch === this.admissionEpoch && (!event || event.current())
    let attempts = 0
    let retryDeadline = deadline
    return new grpc.InterceptingCall(new AdmissionRetryCall({ ...options, deadline },
      (attemptOptions, notBefore) => {
        const retrySignal = attempts++ > 0 ? this.admissionRetries.signal : undefined
        return this.interceptAttempt({ ...attemptOptions, deadline: retryDeadline }, nextCall, context, event, notBefore, { current, retrySignal })
      },
      (): boolean => {
        if (!current() || this.admissionRetries.signal.aborted || signalsOf(context).some(signal => signal.aborted) || Date.now() >= retryDeadline) { return false }
        // Calls without a caller deadline still get one finite, non-renewing requeue budget.
        if (!Number.isFinite(retryDeadline)) { retryDeadline = Date.now() + this.budget }
        if (this.onUnsubmitted) { return this.onUnsubmitted() }
        this.begin()
        return true
      },
    ))
  }

  private interceptAttempt (
    options: grpc.InterceptorOptions,
    nextCall: grpc.NextCall,
    context: RequestContext,
    event?: EventContext,
    notBefore = 0,
    admission?: AdmissionFence,
  ): grpc.InterceptingCall {
    const method = options.method_definition.path.split('/').pop() ?? ''
    const bypass = controls.has(method) || (event !== undefined && replayReads.has(method) && !admission?.retrySignal)
    const signals = signalsOf({ signals: signalsOf(context), signal: bypass ? this.controls.signal : undefined })
    const deadline = Math.min(
      context.deadline ?? Infinity,
      options.deadline instanceof Date ? options.deadline.getTime() : options.deadline ?? Infinity,
      bypass && method !== 'Event' ? Date.now() + this.controlTimeout : Infinity,
    )
    const call = nextCall({ ...options, deadline })
    const controller = new AbortController()
    let started = false
    let finished = false
    let reserved = false
    let bytes = 0
    let messages: PendingMessage[] = []
    let rejectCall: (error: unknown) => void = (): void => {}
    const abort = (): void => {
      controller.abort()
      if (started) { call.cancelWithStatus(grpc.status.CANCELLED, 'Request cancelled') } else { rejectCall(new Error('Request cancelled')) }
    }
    return new grpc.InterceptingCall(call, {
      cancel: (next): void => { abort(); next() },
      sendMessage: (message: unknown, next): void => {
        if (finished) { return }
        if (started) { next(message); return }
        try {
          const size = options.method_definition.requestSerialize(message).byteLength
          if (!bypass && this.pendingBytes + size > this.maxPendingBytes) { throw new AdmissionError('Recovery payload capacity exhausted') }
          if (!bypass) { this.pendingBytes += size; bytes += size }
          messages.push({ message, next })
        } catch (error) { rejectCall(error) }
      },
      start: (metadata, listener, next): void => {
        const cancelWaitingRetry = (): void => {
          if (!started) { rejectCall(new Error('Restart preparation prevents deferred submission')) }
        }
        const release = (): void => {
          if (reserved) { this.pendingRequests--; reserved = false }
          this.pendingBytes -= bytes
          bytes = 0
        }
        const cleanup = (): void => {
          finished = true
          messages = []
          release()
          for (const signal of signals) { signal.removeEventListener('abort', abort) }
          admission?.retrySignal?.removeEventListener('abort', cancelWaitingRetry)
        }
        rejectCall = (error: unknown): void => {
          if (finished) { return }
          const cancelled = controller.signal.aborted
          cleanup()
          controller.abort()
          call.cancelWithStatus(grpc.status.CANCELLED, 'Not submitted')
          listener.onReceiveStatus({
            code: error instanceof AdmissionError ? error.code : cancelled ? grpc.status.CANCELLED : Date.now() >= deadline ? grpc.status.DEADLINE_EXCEEDED : grpc.status.UNAVAILABLE,
            details: error instanceof Error ? error.message : String(error),
            metadata: new grpc.Metadata(),
          })
        }
        if (!bypass) {
          if (this.pendingRequests >= this.maxPendingRequests) { rejectCall(new AdmissionError('Recovery request capacity exhausted')); return }
          this.pendingRequests++; reserved = true
        }
        for (const signal of signals) { signal.addEventListener('abort', abort, { once: true }) }
        admission?.retrySignal?.addEventListener('abort', cancelWaitingRetry, { once: true })
        if (admission?.retrySignal?.aborted) { cancelWaitingRetry() }
        if (signals.some(signal => signal.aborted)) { abort() }
        const send = async (): Promise<void> => {
          await this.waitForAttempt(notBefore, deadline, controller.signal)
          while (true) {
            await this.wait({ deadline, signal: controller.signal }, bypass)
            if (bypass || this.value.status !== 'recovering') { break }
          }
          if (!bypass && this.value.status === 'offline') { throw new Error(this.value.reason) }
          if (event && !event.current()) { throw new Error('Superseded event epoch') }
          if (admission && (!admission.current() || admission.retrySignal?.aborted)) { throw new Error('Superseded admission attempt') }
          if (controller.signal.aborted || Date.now() >= deadline) { throw new Error('Request cancelled or expired') }
          if (finished) { return }
          started = true
          release()
          next(metadata, {
            onReceiveMetadata: (value, nextMetadata): void => { nextMetadata(value) },
            onReceiveMessage: (value: unknown, nextMessage): void => { nextMessage(value) },
            onReceiveStatus: (status, nextStatus): void => { cleanup(); nextStatus(status) },
          })
          const buffered = messages
          messages = []
          for (const pending of buffered) { pending.next(pending.message) }
        }
        void send().catch(rejectCall)
      },
    })
  }

}
