# Native resource and lobby UI acceptance — 2026-10-22

This release moves resource management and the two-player lobby into the Rust
game shell. It supersedes the HTML panels in the earlier content delivery
release; `native-content-acceptance.md` remains that release's historical record.

## Release identity

| Item | Verified value |
| --- | --- |
| Native source | `54c3a2f12a6b976f5b06ee33f006a3edbbdd0930` |
| Native patch | `c8df1a92ba80a45f5e75aaaf91dbfba0266846bf70eaf8c2abc1f1be8935e247` |
| Raw WASM | 26,968,035 bytes; `10f6320d357b4a928b73570d1a274ee430820d4f75870ddadc938e3217be50fe` |
| WASM download | 10,144,275 bytes; `61e08f0260e4f5ddf0a504769a19d1eaa6d78247718b11a2212fea344c77fa80` |
| Release manifest | `c8c8557edd88d6d583fdb1632c99b94bc9d2123ab4ff64f4ab8eee88d398a8bd` |
| Worker version | `b053be66-0521-4436-b7e5-c534cbacd4b4` |
| Public origin | https://wan.youlidefuchou.com/ |

The required resource identity and optional pack catalog remain unchanged.
Existing verified art caches can be reused. Default skirmish content is 26
files / 279,134,944 wire bytes. Campaign, cinematics, music and the approved
4,110,830-byte menu MP4 remain optional.

## Native presentation and input

The pages use the existing shell art, button/checkbox atlases, bitmap text,
software cursor and GPU presenter. DOM inspection on the public resource page
found only `CANVAS` visible. There is no resource/lobby CSS panel. Initial
engine-loading progress remains HTML before the native assets are available.

Actual canvas interaction verified Chinese names, native selection controls,
room-code paste/Enter, create/join, ready/start and return to the main menu.
The offscreen IME/paste textarea is removed when entering battle; both local
and public battle receipts record zero textareas.

Resource download/verification, dependency selection, cancellation and
activation/reload were exercised during the first native UI build. The final
build additionally fixes popup labels painting through the dropdown and canvas
clipping after viewport resize. At 774 × 820 CSS pixels / DPR 2, the final canvas
was 774 × 820 CSS pixels with a 1548 × 1640 buffer and matching native window
dimensions. The final resource page was reopened after completing a match.

## Actual engine gameplay

These were two real browser instances using the native engine, actual canvas
input and real WebSockets, separately from the synthetic transport probes.

| Surface | Result |
| --- | --- |
| Local `127.0.0.1:5281` | Both clients entered battle; host moved and deployed its MCV; guest resigned through the native task menu; both finished at tick 1150 with `retail:1150:e88af840`, no network error. Both continued to the main menu; resource management reopened. Running diagnostics showed 20 TPS. |
| Public domain | Both entered from the native lobby; running tick 338 CRC matched; guest resigned through the native task menu; both finished at tick 730 with `retail:730:6d4c4100`, no network error, then continued to the main menu. |

The public run still measured approximately 5.94–5.95 TPS. This UI release does
not resolve the previously observed public lockstep pacing limitation and does
not claim local/public speed parity. This is a short lifecycle regression,
not a sustained full-match performance acceptance run or physical iPhone test.

## Automated and publication checks

- Root Node suite: 110/110 passed.
- Native `cargo test --lib browser_shell`: 12/12 passed.
- Deployment suite: 15/15 passed; TypeScript check and Wrangler dry-run passed.
- Final browser build and pinned native source check passed.
- Upload receipt matched the release manifest; 72 content-addressed objects.
- Public verification passed all 72 object HEADs, raw/gzip WASM range checks,
  build/catalog identities and the two-socket transport probe. Six changed JS
  files matched their packaged SHA256; the Worker-generated build JSON matched
  the release object semantically.
- The auxiliary workers.dev verifier reached matching health/build/catalog but
  twice stopped with `fetch failed` during object HEADs. It is not recorded as
  a passing complete probe. The requested custom domain passed, including
  actual browser gameplay.
- Protected source audit passed: all 6,252 VERA and 2,513 WERHD files, Git HEADs
  and worktree states match the original read-only baseline. No sibling source
  repository was modified.

## Local evidence

Ignored runtime artifacts are stored under `validation/` and `.build/`:

- `native-shell-resources-final.png`, `native-shell-lobby-final.png`,
  `native-shell-popup-fixed.png`, `native-shell-viewport.png`.
- `native-shell-public-resources.png`, `native-shell-public-lobby.png`.
- `native-shell-local-match.json`, `native-shell-public-running.json`,
  `native-shell-public-match.json`.
- `native-shell-public-verification.json`,
  `native-shell-static-verification.json`,
  `native-shell-workersdev-verification{,-retry}.json`.
- `native-shell-isolation.json`, `native-shell-workers-deploy.txt`,
  `native-shell-upload.log`.
- `.build/native-shell-build-verified.log`,
  `.build/native-shell-node-tests.log`,
  `.build/native-shell-rust-tests-final.log`.
