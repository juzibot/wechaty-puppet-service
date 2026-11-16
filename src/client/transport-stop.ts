export interface TransportStopOptions {
  /** Bound for the whole stop; on expiry the SDK releases the transport itself. Default 15_000. */
  readonly timeoutMilliseconds?: number
}

export interface TransportStopReceipt {
  /** The event stream is destroyed and the gRPC client closed; this manager never sends another RPC. */
  readonly released: boolean
  /** The server answered the Stop RPC with success. */
  readonly serverAcked: boolean
  /** The SDK released the transport because the stop timed out. */
  readonly forced: boolean
  /** Why the Stop RPC failed or was never answered. Informational: it does not affect `released`. */
  readonly stopError?: Error
  /** Why `released` is false: the event stream destroy or the client close threw. */
  readonly releaseError?: Error
}

/** What a manager records about its own stop and release, read instead of global error events. */
export interface TransportReleaseState {
  readonly released: boolean
  readonly serverAcked: boolean
  readonly stopError?: Error
  readonly releaseError?: Error
}

export interface ReleasableTransport {
  releaseState (): TransportReleaseState
  forceRelease (): TransportReleaseState
}

export const DEFAULT_TRANSPORT_STOP_TIMEOUT_MILLISECONDS = 15_000

export function toError (error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function transportStopTimeout (options: TransportStopOptions): number {
  const timeout = options.timeoutMilliseconds
  return timeout !== undefined && Number.isFinite(timeout) && timeout >= 0
    ? timeout
    : DEFAULT_TRANSPORT_STOP_TIMEOUT_MILLISECONDS
}

function buildReceipt (state: TransportReleaseState, forced: boolean, fallbackStopError?: Error): TransportStopReceipt {
  const stopError = state.stopError ?? (state.serverAcked ? undefined : fallbackStopError)
  return {
    released    : state.released,
    serverAcked : state.serverAcked,
    forced,
    ...(stopError ? { stopError } : {}),
    ...(state.releaseError ? { releaseError: state.releaseError } : {}),
  }
}

function releaseQuietly (transport: ReleasableTransport): TransportReleaseState {
  try {
    return transport.forceRelease()
  } catch (error) {
    return { ...transport.releaseState(), released: false, releaseError: toError(error) }
  }
}

async function settlesWithin (operation: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<boolean>((resolve): void => { timer = setTimeout((): void => resolve(false), milliseconds) })
  try {
    return await Promise.race([ operation.then((): boolean => true, (): boolean => true), expiry ])
  } finally { clearTimeout(timer) }
}

/**
 * Resolves (never rejects) once `stopping` settles or the timeout expires, whichever is first.
 * Without `stopping` the transport's earlier release failed and it is released again directly.
 */
export async function settleTransportStop (
  transport: ReleasableTransport,
  stopping: Promise<void> | undefined,
  timeoutMilliseconds: number,
): Promise<TransportStopReceipt> {
  if (!stopping) { return buildReceipt(releaseQuietly(transport), false) }
  if (!await settlesWithin(stopping, timeoutMilliseconds)) {
    return buildReceipt(releaseQuietly(transport), true, new Error(`Transport stop timed out after ${timeoutMilliseconds} ms`))
  }
  const state = transport.releaseState()
  if (state.released || state.releaseError) {
    return buildReceipt(state, false)
  }
  // The stop finished without reaching this manager's Stop: release it rather than report it live.
  return buildReceipt(releaseQuietly(transport), false, new Error('Stop RPC was not sent'))
}
