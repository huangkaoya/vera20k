# Protocol 3 validation record

Date: 2026-10-22. This record separates actual engine gameplay, synthetic
100-client transport acceptance and earlier failed public attempts. It is not
500-player capacity acceptance or a test of 100 simultaneous WASM worlds.

## Build identity

- Integrated native source: `54c3a2f12a6b976f5b06ee33f006a3edbbdd0930`.
- Browser patch: `f2def12046dacde6480c693d92e1cd9451d4d8efb9879dc266c65a830a0b93b3`.
- WASM: `f50ac8a904723bbbc6d46bc2d69b125972233f1e01ad5b33c73229ff1caa3802`.
- Release manifest: `233583cc8bced6bb9e1b11f2498526d0f5f3d56f8a07eb633efaa0c865070145`.
- Initial public Worker: `bc4f6412-407d-4781-89a3-f9ff2efce797`.
- Added close-event diagnostics: `263b5437-d4d8-491c-926c-9a41e15e978e`.
- Added eight fixed room shards: `c9af7550-95cf-4a6b-ab90-8654f35dddfe`.
- Added bounded idle cleanup and callback guards:
  `44809dde-d684-4950-b80f-e10a37fbb863`.

No simulation rules were updated. No new upstream candidate was promoted.

## Passing gates

- Node suite: 123 tests; production Rust network module: 5 tests.
- Fixed-source reconstruction fixtures: 6 tests; candidate updater: 12 tests.
- Worker deployment suite: 15 tests; Worker types and deployment dry-run passed.
- The close-log addition subsequently passed the 10 lobby tests and 15 Worker
  tests again, plus Worker type checking.
- Actual JS/WASM hashes, all 72 release objects and upload receipt matched the
  release; public resource/range/origin/protocol checks passed.

Two actual native-WASM clients ran through an added 250 ms loopback RTT at
normal speed. A measured long interval yielded 20.8223/20.8177 TPS. Movement,
deployment, production and placement were exercised. Both clients finished
at tick 23460 with `retail:23460:e0b43adf`, no error; a fresh match finished
at tick 5420 with `retail:5420:66a962ba`, no error.

Ignored local evidence: `validation/native-pipeline-rtt250-*.json` and PNGs,
build/test logs under `.build/`, and `validation/native-pipeline-isolation.json`.
The original VERA and WERHD trees retained all baseline file hashes and Git
status. The original Go repository was read only.

The final 100-user routing/liveness changes passed 149 Node tests, 23 Worker tests, Worker
type checking and all 12 updater fixtures. The actual WebSocket load tool
passed local 100-client / 50-room admission, 600 concurrent frames and a
16-frame re-entry round. The common commit overlap was 29.102 seconds;
per-peer TPS minimum 20.568, median 20.579. Every synthetic final receipt and
room return matched, all 100 sockets closed normally and local room count
returned to zero. This is server/protocol load acceptance, not 100 actual
WASM worlds. Evidence: `validation/native-network-load-local.json`.

## Passing public results

Two actual native-WASM clients used the public frontend and native game UI on
the sharded deployment `c9af7550-95cf-4a6b-ab90-8654f35dddfe`. No tail session
or deployment changed during these matches. Movement, deployment, power-plant
production and placement were exercised in room `S4B0EAC` (shard 4). The
measured running interval yielded 20.0320/20.0747 TPS. Match
`ff6f67e6-d0fa-454f-805a-4d5567f2bede` finished normally on both clients at
tick 5920 with `retail:5920:cc5f1cb3`, `phase:finished` and `error:null`.
Both returned to the main menu and entered room `S04B89E` (shard 0). Match
`abc7b3e8-a32e-4f26-8064-d32df4b8285d` finished at tick 4020 on both clients
with `retail:4020:cc020cf1`, again without error. Both returned to menus.
Evidence: `validation/native-sharded-game-*.json` and associated PNGs.

The latest deployment `44809dde-d684-4950-b80f-e10a37fbb863` passed the full
100-connection / 50-room public load run at UTC 11:08:16–11:10:06. All peers
were ready before pumping 2000 concurrent frames at the 48 ms cadence. Common
commit overlap was 98.0466 seconds; per-peer TPS minimum 19.432, median 19.971,
mean 19.984, maximum 20.366. All 50 synthetic terminal CRC receipts matched,
all rooms returned, and all 100 peers completed a fresh 16-frame round.
Every socket closed cleanly with code 1000, none required termination, health
identity stayed unchanged, and the report had no failures. Evidence:
`validation/native-network-load-public-100-liveness.json`.

This second gate exercises real public WebSockets and the production
coordinator with synthetic empty commands/checksums. Its explicit
`engineGameplayVerified:false` prevents treating it as 100 engine instances.
The two actual-game matches above are a separate gate on the unchanged WASM;
their server version precedes the final heartbeat/cleanup additions.
An actual browser on the latest deployment also retained native lobby room
`S48A662` beyond 80 seconds of idle time and then received an acknowledged
configuration change. It subsequently left the room. Evidence:
`validation/native-sharded-lobby-idle.json` and PNG. This checks that the new
client heartbeat preserves a waiting lobby beyond the server's idle deadline.

## Earlier public failures and diagnostic limits

Retain earlier attempts rather than replacing failed evidence:

| Run | Result |
| --- | --- |
| 120-frame synthetic WS probe | 15.81/15.89 TPS; turn delivery p95 670–718 ms |
| 2000-frame synthetic WS probe | Completed, 15.21/15.21 TPS; turn delivery p95 848–877 ms |
| 120-frame self-echo probe | 20.25/19.88 TPS; seven application RTT samples per peer, mean 206/268 ms |
| Actual match `ad255ded-8dd9-44fe-9064-c638b30ec9c4` | Stopped around tick 3252; guest connection interrupted, host timed out |
| Actual match `4d5fcc19-57ae-461f-8de9-5780cd40a19f` | Both connections interrupted around tick 590 |
| Actual match `dcc58617-c686-4316-9a2b-b5b80eb472fc` | Movement and deployment executed; later stopped around tick 1968; host close code 1006, unclean |
| Actual match `bab68385-536b-436b-8b9e-c986d5663dc3` | Both peers closed 1006 at 09:58:23 UTC, around tick 1225; tail was already active before either WS opened |
| Initial sharded 100-client / 2000-frame load | Failed around 45 seconds: room-36-host, shard 4, closed at tick 637; all sockets cleaned up, primary/re-entry incomplete |
| Diagnostic sharded 100-client run | Shard 4's 12 sockets closed 1006 at 10:27:00 UTC; primary incomplete, partial TPS median 18.017 |
| Tailed sharded 100-client run | Shard 0 guest closed 1006 at tick 1663; primary incomplete, partial TPS median 19.014 |

The synthetic probes do not load the engine. Their receipts explicitly mark
`engineGameplayVerified:false`. The short self-echo run is a different network
interval; it does not invalidate the slower long run. Self-echo measures the
same DO application's round trip without the two-player input barrier, while
turn delivery includes peer and scheduling waits.

The fixed eight-frame window covers about 384 ms at normal speed. The long
public delivery tail exceeds that budget. This explains residual waiting but
does not explain WebSocket closure: the second actual match still had buffered
turns when its connections closed. No CRC mismatch or window-overflow error
was observed. Code 1006 alone does not locate the failing hop. The later
successful matches do not change the failed classification of these attempts.

Exact run evidence remains in `validation/native-pipeline-public-*.json`, close
logs and screenshots, plus `validation/native-network-load-public-100*.json`.
Cloudflare metrics recorded shard 4 `scriptThrewException` outcomes for the
12 long-lived requests in the diagnostic run, without a CPU/memory-limit
outcome. This does not prove 12 independent exceptions. Exact persisted-log
queries returned 403 with the current CLI profile; the exception stack and
original shared-closure cause remain unresolved. A later shard 0 connection
remained server-side for over six minutes after the load tool had closed all
sockets. This established the half-open slot-reclamation defect addressed by
the 45-second cleanup and 15-second client ping. Callback guards additionally
isolate room faults. One subsequent complete passing load run validates the
latest build for that measured interval, not immunity to future network faults.

The final strict sibling audit (`validation/native-sharded-isolation.json`)
checked 6252 VERA and 2513 WERHD paths, including symlink text. All hashes,
path sets, HEADs and Git status matched the protected baseline. No original
Go server was modified. The requested acceptance scale is 100 users.
