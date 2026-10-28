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

## Proven non-admission (opt-in)

With recovery enabled, generated Puppet business unary calls add request metadata
`x-juzi-recovery-capability: admission-reject-v1`. Control RPCs and streaming RPCs
are excluded. Work may return `UNAVAILABLE` with **both** exact trailing values:

- `x-juzi-request-state: not-submitted`
- `x-juzi-recovery-capability: admission-reject-v1`

These trailers must only be issued before business acceptance. If no response
message has been received, SDK re-enters the recovery admission queue, forcing
stream recovery first even when it has not yet observed stream end. Each re-entry
reserves request/byte capacity again and backs off 50ms exponentially to 1s.
The original request is snapshotted once; each wire attempt sends a fresh protobuf
decoded from that snapshot. Absolute caller/RPC deadlines never grow. Calls with
no deadline receive a non-renewing recovery-budget deadline on their first rejection.

Missing/partial/wrong trailers, non-UNAVAILABLE statuses, and errors after a
response never trigger this protocol. This is not general transport retry;
`grpc.enable_retries` remains zero. Cancellation, logout/account/session changes,
event-epoch supersession and local restart preparation fence deferred attempts.
Preparation does not cancel attempts already submitted to the server.

grpc-js emits a synthetic `null` before a unary error without a response. This
adapter is restricted by serializer/decoder identity to the generated Puppet
protobuf methods, whose real frames decode to non-null messages. It is not an
interceptor for arbitrary nullable custom decoders. grpc-js captures its original
method definition; replacing `options.method_definition` does not override its
wire codec. Snapshot reconstruction therefore uses the generated service decoder.

Library behavior was checked against installed `client-interceptors.d.ts/js` and
the official example at
https://github.com/grpc/grpc-node/blob/master/examples/interceptors/client.js.
Real gRPC tests cover the synthetic-null path and actual response-then-error path.

## Local validation (2026-10-28)

- RED: TypeScript rejected the new tests solely because the public API was absent.
- GREEN: seven restart tests, including real gRPC pending-write and legacy startup
  races; fourteen recovery regressions; one GrpcManager smoke test.
- Admission RED reproduces a marked UNAVAILABLE terminating the logical call;
  ten admission integration groups now pass, including repeated rejection,
  protocol negatives, deadlines/cancellation, both queue limits, lifecycle fences,
  response-then-error, control/stream exclusion, the ready-window race, direct
  call cancellation and the finite retry budget for callers without a deadline.
- ESM/CJS compiled against exact published grpc/puppet `1.2.0` in the independent
  `.validation-overlay`; shared `node_modules` and dependency manifests unchanged.
- Logs/artifacts remain in `.validation-overlay` (untracked); package version stays
  `1.2.0`. No package publication or remote Git operation is part of this change.
