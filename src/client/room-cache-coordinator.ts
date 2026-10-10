class RoomCacheOperationError extends Error {

  constructor (roomId: string, readonly original: unknown) {
    super(`Room cache ${roomId} failed: ${original instanceof Error ? original.message : String(original)}`)
    this.name = 'RoomCacheOperationError'
  }

}

class RoomCacheCoordinator {

  private readonly generations = new Map<string, number>()
  private readonly pending = new Map<string, Promise<void>>()

  generation (roomId: string): number {
    return this.generations.get(roomId) ?? 0
  }

  invalidate (roomId: string): void {
    this.generations.set(roomId, this.generation(roomId) + 1)
  }

  async run<Result> (roomId: string, operation: () => Promise<Result>): Promise<Result> {
    const preceding = this.pending.get(roomId) ?? Promise.resolve()
    const result = (async (): Promise<Result> => {
      await preceding
      return operation()
    })()
    // Only the queue barrier settles errors; the caller still receives the rejected result.
    const barrier = result.then((): undefined => undefined, (): undefined => undefined)
    this.pending.set(roomId, barrier)
    try {
      return await result
    } catch (error) {
      throw error instanceof RoomCacheOperationError ? error : new RoomCacheOperationError(roomId, error)
    } finally {
      if (this.pending.get(roomId) === barrier) { this.pending.delete(roomId) }
    }
  }

  async commit (roomId: string, generation: number, operation: () => Promise<unknown>): Promise<void> {
    await this.run(roomId, async (): Promise<void> => {
      if (this.generation(roomId) !== generation) { return }
      await operation()
    })
  }

}

export { RoomCacheCoordinator, RoomCacheOperationError }
