import { grpc, puppet } from '@juzi/wechaty-grpc'

type InnerCall = ConstructorParameters<typeof grpc.InterceptingCall>[0]
type MessageContext = Parameters<InnerCall['sendMessageWithContext']>[0]
type Auth = ReturnType<InnerCall['getAuthContext']>
type CallListener = NonNullable<Parameters<InnerCall['start']>[1]>
type CallStatus = Parameters<NonNullable<CallListener['onReceiveStatus']>>[0]
type CreateAttempt = (options: grpc.InterceptorOptions, notBefore: number) => InnerCall

interface Attempt {
  call?: InnerCall
  metadata?: grpc.Metadata
  hasResponse: boolean
  sent: boolean
  halfClosed: boolean
  reading: boolean
}

export class AdmissionRetryCall implements InnerCall {

  private current?: Attempt
  private metadata?: grpc.Metadata
  private listener?: CallListener
  private snapshot?: Buffer
  private context: MessageContext = {}
  private halfClosed = false
  private reading = false
  private attemptCount = 0
  private responseDelivered = false
  private metadataDelivered = false
  private terminal?: CallStatus
  private terminalDelivered = false

  constructor (
    private readonly options: grpc.InterceptorOptions,
    private readonly createAttempt: CreateAttempt,
    private readonly onUnsubmitted: () => boolean,
  ) {}

  start (metadata: grpc.Metadata, listener?: CallListener): void {
    if (this.metadata) { return }
    this.listener = listener
    this.metadata = metadata.clone()
    this.metadata.set('x-juzi-recovery-capability', 'admission-reject-v1')
    if (this.terminal) { this.deliverTerminal(); return }
    this.beginAttempt(0)
  }

  sendMessage (message: unknown): void {
    this.sendMessageWithContext({}, message)
  }

  sendMessageWithContext (context: MessageContext, message: unknown): void {
    if (this.terminal || this.snapshot !== undefined) { return }
    try {
      this.snapshot = Buffer.from(this.options.method_definition.requestSerialize(message))
      this.context = { ...context }
    } catch (error) { this.fail(error); return }
    this.replay()
  }

  halfClose (): void {
    this.halfClosed = true
    this.replay()
  }

  startRead (): void {
    this.reading = true
    this.replay()
  }

  getPeer (): string { return this.current?.call?.getPeer() ?? '' }

  getAuthContext (): Auth { return this.current?.call?.getAuthContext() ?? null }

  private beginAttempt (notBefore: number): void {
    if (this.terminal || !this.metadata) { return }
    const attempt: Attempt = { hasResponse: false, sent: false, halfClosed: false, reading: false }
    this.current = attempt
    this.attemptCount++
    try {
      attempt.call = this.createAttempt({
        ...this.options,
        method_definition: {
          ...this.options.method_definition,
          requestSerialize: (): Buffer => {
            if (this.snapshot === undefined) { throw new Error('Missing request snapshot') }
            return this.snapshot
          },
        },
      }, notBefore)
      if (!this.isCurrent(attempt)) { return }
      attempt.call.start(this.metadata.clone(), {
        onReceiveMetadata: (metadata): void => {
          if (!this.isCurrent(attempt)) { return }
          attempt.metadata = metadata
          if (attempt.hasResponse) { this.deliverMetadata(attempt) }
        },
        onReceiveMessage: (message: unknown): void => this.receiveMessage(attempt, message),
        onReceiveStatus: (status): void => this.receiveStatus(attempt, status),
      })
    } catch (error) {
      if (this.isCurrent(attempt)) { this.fail(error) }
      return
    }
    if (this.isCurrent(attempt)) { this.replay() }
  }

  private isCurrent (attempt: Attempt): boolean {
    return !this.terminal && this.current === attempt
  }

  private replay (): void {
    const attempt = this.current
    if (!attempt?.call || !this.isCurrent(attempt)) { return }
    try {
      if (this.snapshot !== undefined && !attempt.sent) {
        attempt.sent = true
        const message = this.restoreRequest(this.snapshot)
        attempt.call.sendMessageWithContext({ ...this.context }, message)
      }
      if (!this.isCurrent(attempt)) { return }
      if (this.halfClosed && !attempt.halfClosed) {
        attempt.halfClosed = true
        attempt.call.halfClose()
      }
      if (!this.isCurrent(attempt)) { return }
      if (this.reading && !attempt.reading) {
        attempt.reading = true
        attempt.call.startRead()
      }
    } catch (error) {
      if (this.isCurrent(attempt)) { this.fail(error) }
    }
  }

  private restoreRequest (snapshot: Buffer): unknown {
    // grpc-js client definitions omit requestDeserialize; recover it from the
    // same generated service definition that the gate checks for eligibility.
    const method = this.options.method_definition
    const definition = Object.values(puppet.PuppetService).find(candidate =>
      candidate.path === method.path && candidate.requestSerialize === method.requestSerialize
      && candidate.responseDeserialize === method.responseDeserialize,
    )
    if (!definition) { throw new Error('Missing generated protobuf request deserializer') }
    return definition.requestDeserialize(snapshot)
  }

  private receiveMessage (attempt: Attempt, message: unknown): void {
    if (!this.isCurrent(attempt)) { return }
    // The gate admits only generated protobuf methods: real frames decode to
    // non-null messages. grpc-js injects null before a unary status without one.
    if (message === null) { return }
    attempt.hasResponse = true
    this.deliverMetadata(attempt)
    if (!this.isCurrent(attempt) || this.responseDelivered) { return }
    this.responseDelivered = true
    this.listener?.onReceiveMessage?.(message)
  }

  private receiveStatus (attempt: Attempt, status: CallStatus): void {
    if (!this.isCurrent(attempt)) { return }
    const states = status.metadata.get('x-juzi-request-state')
    const capabilities = status.metadata.get('x-juzi-recovery-capability')
    const retryable = status.code === grpc.status.UNAVAILABLE && !attempt.hasResponse
      && states.length === 1 && states[0] === 'not-submitted'
      && capabilities.length === 1 && capabilities[0] === 'admission-reject-v1'
    if (retryable) {
      let retry: boolean
      try { retry = this.onUnsubmitted() } catch (error) { this.fail(error); return }
      if (!this.isCurrent(attempt)) { return }
      if (retry) {
        const delay = Math.min(50 * 2 ** Math.min(this.attemptCount - 1, 5), 1000)
        this.beginAttempt(Date.now() + delay)
        return
      }
    }
    this.finish(status)
  }

  private deliverMetadata (attempt: Attempt): void {
    if (this.metadataDelivered || !attempt.metadata) { return }
    this.metadataDelivered = true
    this.listener?.onReceiveMetadata?.(attempt.metadata)
  }

  private finish (status: CallStatus): void {
    if (this.terminal) { return }
    this.terminal = status
    this.deliverTerminal()
  }

  private deliverTerminal (): void {
    if (!this.terminal || !this.metadata || this.terminalDelivered) { return }
    this.terminalDelivered = true
    if (this.current) { this.deliverMetadata(this.current) }
    if (!this.responseDelivered) {
      this.responseDelivered = true
      this.listener?.onReceiveMessage?.(null)
    }
    this.listener?.onReceiveStatus?.(this.terminal)
  }

  private fail (error: unknown): void {
    const details = error instanceof Error ? error.message : String(error)
    this.cancelWithStatus(grpc.status.INTERNAL, details)
  }

  cancelWithStatus (code: grpc.status, details: string): void {
    if (this.terminal) { return }
    const call = this.current?.call
    try {
      this.finish({ code, details, metadata: new grpc.Metadata() })
    } finally {
      call?.cancelWithStatus(code, details)
    }
  }

}
