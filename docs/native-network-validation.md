# Protocol 3 validation record

Date: 2026-10-22. This record separates passing implementation gates from
unresolved public runtime results. It is not 500-player capacity acceptance.

## Build identity

- Integrated native source: `54c3a2f12a6b976f5b06ee33f006a3edbbdd0930`.
- Browser patch: `f2def12046dacde6480c693d92e1cd9451d4d8efb9879dc266c65a830a0b93b3`.
- WASM: `f50ac8a904723bbbc6d46bc2d69b125972233f1e01ad5b33c73229ff1caa3802`.
- Release manifest: `233583cc8bced6bb9e1b11f2498526d0f5f3d56f8a07eb633efaa0c865070145`.
- Initial public Worker: `bc4f6412-407d-4781-89a3-f9ff2efce797`.
- Added close-event diagnostics: `263b5437-d4d8-491c-926c-9a41e15e978e`.

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

## Public results: incomplete gameplay acceptance

The public repair was deployed, but complete stable gameplay acceptance is
still outstanding. Retain every attempt rather than replacing failed evidence:

| Run | Result |
| --- | --- |
| 120-frame synthetic WS probe | 15.81/15.89 TPS; turn delivery p95 670–718 ms |
| 2000-frame synthetic WS probe | Completed, 15.21/15.21 TPS; turn delivery p95 848–877 ms |
| 120-frame self-echo probe | 20.25/19.88 TPS; seven application RTT samples per peer, mean 206/268 ms |
| Actual match `ad255ded-8dd9-44fe-9064-c638b30ec9c4` | Stopped around tick 3252; guest connection interrupted, host timed out |
| Actual match `4d5fcc19-57ae-461f-8de9-5780cd40a19f` | Both connections interrupted around tick 590 |
| Actual match `dcc58617-c686-4316-9a2b-b5b80eb472fc` | Movement and deployment executed; later stopped around tick 1968; host close code 1006, unclean |

The synthetic probes do not load the engine. Their receipts explicitly mark
`engineGameplayVerified:false`. The short self-echo run is a different network
interval; it does not invalidate the slower long run. Self-echo measures the
same DO application's round trip without the two-player input barrier, while
turn delivery includes peer and scheduling waits.

The fixed eight-frame window covers about 384 ms at normal speed. The long
public delivery tail exceeds that budget. This explains residual waiting but
does not explain WebSocket closure: the second actual match still had buffered
turns when its connections closed. No CRC mismatch or window-overflow error
was observed. Code 1006 alone does not locate the failing hop. A normal finish,
equal terminal CRC and public re-entry are not yet proven for these attempts.

Exact run evidence remains in `validation/native-pipeline-public-*.json`, close
logs and screenshots. Public connection/placement diagnosis and complete
actual-engine lifecycle acceptance remain required before claiming the public
multiplayer fix fully validated. The current single DO's 64-client/32-room
limits also remain; 500 simultaneous users need separate architecture and
load acceptance.
