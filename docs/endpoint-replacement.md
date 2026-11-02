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
5. UUID FileBoxes issued by the old endpoint are refused afterwards.

`onStop()` cancels a pending replacement first and then runs the normal stop. While a replacement
is pending, `reset()` and stream recovery are deferred; if the old stream was lost meanwhile and the
replacement fails, the loss is handed back to normal recovery on the old connection. Any failure
before publication keeps the old connection. `replacingEndpoint` and `cancelEndpointReplacement()` are exposed for callers.
