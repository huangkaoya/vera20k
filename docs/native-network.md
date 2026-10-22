# Native network protocol 3

The Rust simulation remains the only owner of movement, production, combat,
RNG and world advancement. The room coordinator orders native commands; it
does not simulate a second world. Node is the local transport host. Cloudflare
executes the same coordinator in a Durable Object, without a Node server.

## Removing the per-frame network round trip

The former input message required the previous committed frame checksum. Both
clients therefore waited for a complete network round trip before submitting
the next frame. A roughly 150 ms round trip could limit a nominal 20 TPS game
to approximately 6 TPS even when simulation and rendering were fast enough.

Protocol 3 separates input admission from committed-state verification:

- Each client seals eight future input frames. Initial frames are empty except
  the final frame, which may take pending commands. Once sealed, an input frame
  cannot be rewritten by later UI input.
- The server accepts continuous frame numbers, bounded by that client's last
  committed checksum cursor plus eight. It broadcasts complete two-player
  turns in order. It never invents missing player commands.
- Rust buffers received turns, validates state-dependent commands at their
  actual execution frame, and advances each native world frame exactly once.
- After a real commit, Rust emits the existing retail CRC before sealing the
  next future input. The server verifies continuous committed cursors and
  compares the two CRCs for each frame independently of input aggregation.
- CRC history, future inputs and receive buffers are bounded. Repeated,
  missing, out-of-window or incompatible messages are rejected.

This is a fixed eight-logical-frame input delay, not zero-latency input or
adaptive rollback. At game speed 3, the original cadence is 48 ms/frame
(20.833 TPS), so eight frames represent about 384 ms. Faster settings shorten
the network time covered by the same window. RTT or jitter beyond the window
can still stall execution; throughput is not guaranteed for arbitrary links.

`networkStatus()` reports `protocol`, `inputDelayTicks`, `submittedThrough`,
`receivedThrough` and `queuedTurns`. Diagnostics are read-only; the tick
difference divided by elapsed wall time is the interval TPS measurement.

## Identity, finish and re-entry

Hello and loaded receipts require protocol 3. The loaded barrier also binds
source revision, browser patch, resource manifest, initial tick and player
mapping. The Worker routes this version to `native-v3`, separate from the old
protocol instance. A build identity match alone does not prove equal world
state: both clients' committed retail CRCs must agree.

Terminal `Queue_AI` handling preserves the original outcome. A non-commit is
not reported as a duplicate CRC. Each client sends the exact terminal tick and
checksum; the coordinator acknowledges completion only when both agree and
their committed cursors permit it. Already sealed future turns are bounded
and retired without further world execution. Socket epochs isolate old
callbacks and completed-match acknowledgements from a later room.

## Repeatable checks

```sh
node --test tests/native-network.test.mjs tests/native-network-latency.test.mjs tests/native-lobby-client.test.mjs tests/native-websocket-delay.test.mjs
node tools/native-network-probe.mjs --origin=http://127.0.0.1:5280 --ticks=120 --tick-ms=48
```

The deterministic latency tests exercise the production coordinator at
150/250 ms RTT with jitter, and retain a one-frame control that reproduces
the RTT-bound slowdown. The WebSocket probe uses synthetic empty commands;
its output explicitly says `engineGameplayVerified:false`.

For actual-engine delay testing, start a separate loopback-only server:

```sh
PORT=5281 VERA_NATIVE_DIAGNOSTIC_RTT_MS=250 npm run start:native-web
```

This adds 125 ms to each direction of each WebSocket path while preserving
message order. The diagnostic option is rejected on non-loopback hosts and
is not used by the public Worker. Capture both actual clients at start,
during play and at finish; verify movement, deployment and production, equal
terminal CRCs, return to menus and a fresh match. The screenshots and JSON
receipts in the ignored `validation/` directory are evidence for a particular
build and run, not a replacement for these checks on future builds.

The upstream candidate workflow runs these contract/latency tests and the
production Rust pipeline tests before its WASM build. Actual native/WASM
replay, two-client CRC, latency and lifecycle receipts remain separate
candidate-bound acceptance requirements. See [native-updates.md](native-updates.md).

## Capacity boundary

The current coordinator defaults to 64 connected clients and 32 rooms, all
inside a single `native-v3` Durable Object in production. This repair does
not establish 500-client capacity. Increasing these constants alone would
not demonstrate capacity or remove a single-object event-processing limit.

For 500 online users, distinguish lobby connections from active player-hours.
At 20 TPS, input plus CRC per frame is 40 incoming messages per active player
per second: 500 active players produce 20,000 events/second. A future Go
service or room-sharded Durable Object deployment must retain the same
admission, ordering, CRC and finish contract, then undergo connection,
multi-room throughput, memory and lifecycle load tests. Existing sibling
Go/WERHD repositories remain unchanged by this repair.
