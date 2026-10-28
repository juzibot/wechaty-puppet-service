# Planned restart preparation

```ts
await puppet.prepareForRestart({ deadline: Date.now() + 30_000 })
// The application must separately await its asynchronous listeners and derived jobs.
await drainApplicationWork()
await puppet.stop()
```

`deadline` is an absolute Unix timestamp in milliseconds. Preparation fences new
events, disables health checks/reconnection/reset, and drains already accepted SDK
events and their metadata writes without closing the business RPC connection.
It does not abort accepted business RPCs or move a ready recovery gate offline.

Repeated calls share one preparation operation, with an independent deadline for
each caller. A caller timeout does not cancel the shared operation or indicate
successful completion. Handler, checkpoint, or stream-close failures remain failed
for subsequent callers. An active startup/recovery/reset is fenced and explicitly
rejected, not reported as a successful drain. Normal stop and a new start are still
required; the new start resets preparation state and ignores the old manager.

The event cursor store is required when recovery is enabled even if event caching
is disabled. The implementation awaits FlashStore writes, not a fabricated flush
API: installed `flash-store@1.3.5` implements `set` with `await levelDb.put` and
`delete` with `await levelDb.del`, without specifying LevelDB's synchronous-write
option. This is **not an fsync/power-loss durability guarantee**, nor an atomic
transaction across cursor keys. It does not close the metadata store while business
work may still need it.

SDK event listeners use EventEmitter semantics. Synchronous listener failures are
captured; promises returned by application listeners are not awaited by EventEmitter.
The Bot must track and await its own asynchronous business completion separately.

## Local validation (2026-10-28)

- RED: TypeScript rejected the new tests solely because the public API was absent.
- GREEN: seven restart tests, including real gRPC pending-write and legacy startup
  races; fourteen recovery regressions; one GrpcManager smoke test.
- ESM/CJS compiled against exact published grpc/puppet `1.2.0` in the independent
  `.validation-overlay`; shared `node_modules` and dependency manifests unchanged.
- Logs/artifacts remain in `.validation-overlay` (untracked); package version stays
  `1.2.0`. No package publication or remote Git operation is part of this change.
