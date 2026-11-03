# Endpoint replacement

`PuppetService.replaceEndpoint(endpoint, { deadline, beforePublish?, assertCurrent?, assertPublishable? })`
moves a logged-in running puppet to a new gRPC endpoint without sending remote `Start` or `Stop`.

1. A candidate `GrpcManager` opens the Event stream on the new endpoint with no cursor
   (sequence numbers are per server and are never carried over).
2. The candidate must send `LOGIN` for the current account and `READY`; with recovery enabled it
   must also send `REPLAY_COMPLETE` for the same account. Events are buffered (4096 events / 8 MiB)
   and de-duplicated by positive sequence number.
3. Only after that handshake does the old stream stop delivering; accepted events, listeners,
   lifecycle work and checkpoints drain. Events keep flowing on the old stream while the candidate
   waits for `READY` (about 15 s on WorkHermit/WorkRemora). The pause in delivery runs from this
   step until publication: the drain, `beforePublish` (persistence and final checks) and the
   synchronous switch.
4. `beforePublish` runs (callers persist the endpoint here), then publication is synchronous:
   the candidate becomes the manager, buffered events replay, the old channel retires after its
   submitted calls finish.
5. UUID FileBoxes issued by the old endpoint are refused afterwards. A media response is wrapped with
   the FileBox class of the transport the request was sent on, so a late answer from the old endpoint
   keeps the old ownership and is refused on download instead of resolving on the new one. A send
   whose serialized boxes include any server UUID (uploaded during the request or already a UUID) is
   bound to the transport current when the request started and is refused before sending if that
   transport was replaced meanwhile; it is not retried or moved. URL and QRCode boxes are portable
   and unaffected.
6. A business call still queued in the recovery gate for the old endpoint (not yet submitted) ends
   locally with UNAVAILABLE once the old endpoint is retired, which happens before the new endpoint's
   buffered events can open the gate. It is not retried on either endpoint; already submitted calls
   keep their original callback.

`onStop()` cancels a pending replacement first and then runs the normal stop. While a replacement
is pending, `reset()` and stream recovery are deferred; if the old stream was lost meanwhile and the
replacement fails, the loss is handed back to normal recovery on the old connection. Any failure
before publication keeps the old connection. `replacingEndpoint` and `cancelEndpointReplacement()` are exposed for callers.

If reopening the old Event stream fails during rollback, the replacement still rejects with its
original error. With recovery enabled, the reopen failure immediately returns to the existing
recovery path; without it, the stream error is emitted once. A concurrent stop or changed runtime
generation prevents either path from restarting the stopped transport.
