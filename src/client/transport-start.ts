export interface TransportStartOptions {
  /** Absolute Unix milliseconds. Expiry invalidates the entire startup attempt. */
  readonly deadline: number
}

type TransportStartResult = { readonly status: 'started' } | { readonly status: 'failed', readonly error: Error }

export class TransportStartAttempt {

  private settle!: (result: TransportStartResult) => void
  private result?: TransportStartResult
  private readonly completion = new Promise<TransportStartResult>((resolve): void => { this.settle = resolve })

  get failed (): boolean { return this.result?.status === 'failed' }

  succeed (): void {
    if (this.result) { return }
    this.result = { status: 'started' }
    this.settle(this.result)
  }

  fail (error: Error): void {
    if (this.result) { return }
    this.result = { status: 'failed', error }
    this.settle(this.result)
  }

  async completed (): Promise<void> {
    const result = await this.completion
    if (result.status === 'failed') { throw result.error }
  }

  async wait (options: TransportStartOptions): Promise<void> {
    if (!Number.isFinite(options.deadline)) { throw new RangeError('Transport start deadline must be finite') }
    let timer: NodeJS.Timeout | undefined
    const check = (): void => {
      const remaining = options.deadline - Date.now()
      if (remaining <= 0) { this.fail(new Error('Transport start deadline exceeded')); return }
      timer = setTimeout(check, Math.min(remaining, 2_147_483_647))
    }
    check()
    try { await this.completed() } finally { clearTimeout(timer) }
  }

}
