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

The requested deployment target is now 100 simultaneous users, tested as 50
two-player rooms rather than 100 idle connections. New rooms are distributed
over eight fixed Durable Objects, each limited to 16 connections and eight
rooms. They share the exact coordinator/CRC contract; a room has one owner
and never combines input from two shards. The local Node server uses the same
eight-coordinator routing for integration and load checks.

`/ws/native?shard=0` through `shard=7` route to `native-v3-shard-N`.
New room codes are seven alphanumeric characters: `S`, shard digit and five
hex digits, for example `S3ABCDE`. Join extracts the explicit shard from this
code. Legacy six-hex codes still use `/ws/native` and the old `native-v3`
coordinator (64 connections / 32 rooms). Missing routing and an invalid query
are distinct: duplicate/unknown query parameters and invalid shards fail 400.

Create initially chooses a shard and tries each of the eight at most once
when it receives an explicit pre-creation capacity rejection (`1013` or
`ROOM_CAPACITY`). It closes the rejected connection and ignores old epoch
callbacks. Ordinary broken connections never replay create, because the
original room's creation outcome may be unknown. Acknowledged room membership
ends this retry path. The limits describe admission, not proven throughput.

At 20 TPS, input plus CRC per frame produces about 4,000 incoming messages per
second across 100 active users. Sharding avoids concentrating all of these
events on one object. It does not remove user/network RTT, packet loss or
unexpected connection closure. Disconnected rooms still stop; reconnect/resume
is not part of this protocol. No 500-user capacity claim is made.

The existing invisible adapter sends an application ping every 15 seconds,
including while waiting in the native lobby. It does not seal input or advance
the simulation. The coordinator releases a client after 45 seconds without
valid protocol traffic. A nonempty DO checks every five seconds and clears
that timer as soon as its last client leaves. Node also uses its existing
transport ping/pong. Callback failures stop the affected room and emit only
sanitized error type/source frames; they do not fabricate successful turns.
These bounds reclaim half-open slots; they do not provide reconnect/resume.

Run the bounded real-WebSocket load tool only against this project or loopback:

```sh
node tools/native-network-load.mjs --origin=http://127.0.0.1:5280 --players=100 --ticks=2000 --tick-ms=48 --self-echo=true
```

It waits for all 100 peers to reach ready, then pumps all 50 rooms together,
checks ordered turns and synthetic CRC receipts, and reopens all rooms. The
report includes the common commit-overlap interval, per-peer TPS and cleanup.
`ok` proves only protocol/lifecycle checks; TPS must be assessed separately.
`engineGameplayVerified:false` is explicit because this tool loads no WASM
world or renderer. Actual two-client gameplay is a separate acceptance gate.
Results, including unsuccessful attempts, are recorded in
[native-network-validation.md](native-network-validation.md). Existing sibling
Go/WERHD repositories remain unchanged.
