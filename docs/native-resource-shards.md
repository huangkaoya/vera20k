# Yuri resource tools on Toy

`dist/toy-resources/plan.json` describes the local, immutable resource-tool ZIPs.
Every archive must be strictly smaller than 50,000,000 bytes. Uploads retain the
original catalog/gameplay identity and do not enable a new production source.
The tool pages describe and validate their actual resource fragments; they do
not contain a game or claim to be an unrelated utility.

On 2026-10-24 the original account (UID 429593303) finished the remaining nine
uploads. All 19 IDs were verified as `published / TOOL / LINK_ONLY`, and all
19 public manifest responses matched their planned SHA-256. See
`validation/toy-resource-remote-status.json` and
`validation/toy-resource-public-manifests-20261024.json`. The user then approved
activation in the main Toy game. Generated Toy exports use the reviewed 19-source set;
local/Cloudflare exports retain their original transport because the Toy CDN
rejects those browser origins. Formal publication is a separate platform gate;
its observed status is in `validation/toy-resource-main-public-status-20261024.json`.
Pack 12 needed one controlled, unchanged-slug recovery after complete account
list reconciliation and a successful preview. Its first unknown attempt remains
in `validation/toy-resource-pack012-recovery-20261024.json` and the journal; this
does not enable unknown-result retries in the publisher.

Build from the existing checked gzip objects, then exercise the same browser
transport over real local HTTP:

```sh
npm run resources:toy:build
npm run resources:toy:check
npm run resources:toy:test
# Download every published part and stream-check complete gzip/raw objects.
npm run resources:toy:verify-public
python3 tools/native-resource-shards-test.py
npm test
```

The current catalog produces 19 ZIPs from 83 parts covering 35 original objects.
The largest ZIP is 48,004,373 bytes. Each part is at most 16,000,000 bytes;
the browser verifies a part before streaming it into the unchanged whole-gzip
and raw-file verification path. These shards contain art/content; the checked
WASM engine is bundled in the main Toy ZIP described below. The default startup
still selects skirmish, while music, campaign and cinematics remain optional.

Rebuilds are deterministic. An existing output directory requires explicit
`build --replace`; keep publication receipts and media before doing so. A sim
update with the same catalog identity can keep the existing resource tools.
Changed catalog bytes must be repackaged and verified before use.

The isolated official CLI is `.build/toy-cli/toy`. The publisher reads its
structured help and uses category `TOOL`, visibility `link-only`, theme `dark`,
titles `尤里版资源校验工具 NN` and catalog-bound slugs
`werhd-yuri-res-<catalog8>-NN`. The user's explicit instruction authorizes direct
submission after local tests. The script does not log in, open authorization
pages, change an existing Toy, or modify another project.

The API requires publishing media even when the CLI help marks those flags as
optional. Defaults are `dist/toy-resources/media/poster.png` and `icon.png`;
override them with `--poster <path>` / `--icon <path>`. The publisher validates
PNG/JPEG signatures, dimensions and SHA, and limits the icon to 512 KB and
1024 pixels per side. Media identities are retained with each attempt.

```sh
# Local artifact admission and command plan only; no Toy API calls.
node tools/publish-native-resource-shards.mjs

# First-package pilot, after the full local HTTP/loader proof has passed.
node tools/publish-native-resource-shards.mjs --submit --limit=1

# Continue sequentially; confirmed matching journal entries are reused.
node tools/publish-native-resource-shards.mjs --submit

# Refresh confirmed IDs only; preserve no-ID rejected/unknown receipts.
node tools/publish-native-resource-shards.mjs --refresh-status

# After quota recovery, explicitly resume a confirmed -509 rejection.
node tools/publish-native-resource-shards.mjs --submit --retry-quota

# Keep an earlier unknown receipt untouched and upload independent packs 13–19.
node tools/publish-native-resource-shards.mjs --submit --from=13
```

Before any submission, the publisher rechecks all ZIP sizes/SHA256 values and
each tool manifest. `validation/toy-resource-http.json` must have `ok:true`, the
matching `catalogIdentity`, exactly 35 verified objects and `planSha256` matching
the exact plan bytes. There is no bypass flag. Limit selects the first N packs,
not N additional submissions.

`--from=N` explicitly starts the execution loop at original-plan ordinal N
(1-based); the default remains 1. It must be within the full plan and must not
exceed a finite `--limit`. The full plan, proof SHA and all artifacts are still
validated, destinations retain their original titles/slugs, and all sources stay
disabled. Earlier unknown receipts are preserved without retry or reclassification;
default execution still stops at an unresolved unknown. This range option lets
independent later packages proceed while platform reconciliation remains pending.
Dry-run and completed summaries include `from` for verification.

Before uploads it enumerates the current account's Toy list and checks exact
slug/title destinations. A matching remote Toy without the matching local
artifact receipt is a conflict, not permission to update it. A per-package
`submitting` entry is atomically saved before invoking `create --json --yes`;
the returned ID/status is atomically saved before querying the list again.
`dist/toy-resources/publication.json` retains the artifact identity, ID, status,
visibility, category, preview/public URLs and exact submission outcome.

If a create call fails without a confirmed ID, the script records that fact,
queries the Toy list for reconciliation, and stops. Running it again never
blindly repeats an unknown create. An operator must reconcile the stored receipt
with the platform; do not delete the journal to force a retry. Earlier attempts
and sanitized API errors are retained. `--refresh-status` updates confirmed IDs
only: no-ID rejection and unknown receipts keep their recorded state and failure
details, without a create attempt or an inferred outcome.

A confirmed create ID proves that submission was accepted even when a Toy has
not yet entered `mylist`. The publisher persists the ID, performs up to three
bounded read-only list checks, then retains `submitted-awaiting-list` and
`metadataVerified:false` while continuing independent uploads. A later list
result must match the exact ID, title, slug, `TOOL` category and `LINK_ONLY`
visibility before verification is marked complete. A mismatch stops the batch;
an absent list record never triggers a duplicate upload. The summary separately
reports `confirmed`, `pendingList`, `quotaRejected`, `notSubmitted` (never
attempted) and `awaitingReview`. Pending review counts confirmed IDs only.

A precisely recorded non-quota validation rejection can be retried only when
its state is `rejected`, `lastFailure.outcome` is `rejected`, the original ZIP identity still
matches, no ID or current matching Toy exists, and the publishing image content
has changed. The prior failure and any earlier unknown observation stay in the
attempt history. Unchanged publishing images do not retry a validation rejection.

Daily creation quota rejection is a separate case. Only a recorded
`lastFailure.apiCode === -509`, `lastFailure.outcome === 'rejected'` and
`state === 'rejected'` with no confirmed ID can use the explicit
`--submit --retry-quota` command. The ZIP and publishing image SHA values must
remain unchanged, and a fresh `mylist` must show no Toy at the exact destination.
Default submission never retries this quota rejection. Do not change slugs or
images to avoid the quota. Each explicit invocation makes at most one attempt
for that rejected pack; if the platform still reports the limit, it stops and
retains the new rejection. It does not loop, schedule a retry or assume a quota
reset time or time zone. Confirmed IDs are reused before continuing the remaining
independent packs.

An unresolved unknown result never permits another create, including with
`--retry-quota`. API status/code/message are retained in sanitized failure
receipts; raw CLI stdout/stderr and credentials are not journaled.

Future transport errors retain an optional fixed stage enum (`upload-init`,
`upload-part`, `upload-complete`, `preview`, `create`) only when the official CLI's
error-line prefix is recognized, plus a recognized `timeout` or `network` reason.
No raw URL, response body or stderr is retained. These diagnostics do not turn a
network failure into a confirmed rejection, and earlier unknown receipts are not
reclassified from elapsed time or an empty list/history result.

`staged-sources.json` and the upload journal's source list retain `enabled:false`:
they describe upload candidates, rather than the active host configuration.
Canonical resource bases use
`https://www.bilibilitoy.com/toy/<slug>/v2/`, never a temporary preview URL.
Uploading, review, actual public resource availability and switching the game
to Toy remain separate steps. The user approved the source change on 2026-10-24.
`web-native/toy-resource-sources.js` now pins every reviewed manifest together with
the catalog and required-resource identities. `packageNativeToy` checks those
identities against the checked local engine and catalog, then uses the production
loader to validate all manifest SHA values and complete coverage before export.
The resulting Toy `host-config.js` and `werhd-release.json` contain all 19 pins.
Missing/overlapping parts, changed bytes, preview URLs or a changed resource
catalog stop packaging. A later upstream sim update may reuse the pins only when
its checked content identities still match; changed content requires a newly
reviewed complete set.

## Main game delivery

The main Toy ZIP is self-contained for startup: it includes the checked engine
JavaScript and gzip WASM, build metadata, content catalog, browser scripts,
generated host configuration, fonts, and branding. It must remain strictly below
50,000,000 bytes. `tools/toy-static-release.mjs` places the complete executable
graph and its assets in `releases/<contenthash>/`. The stable root `index.html`
references that exact directory, and the root `werhd-release.json` records it.
Changes to the exported source bytes or generated configuration select a new
directory, so imports cannot mix old root scripts with a newer configuration.

The generated `staticRelease` maps build, catalog, module and engine transport
paths to files relative to the versioned `host.js`. The gzip object retains its
original descriptor URL, compressed SHA, raw WASM SHA and sizes; only its actual
HTTP location changes to the bundled `native/engine.bin`. The existing loader
still verifies both compressed and decompressed bytes. An unknown object in
this static fallback fails instead of requesting Cloudflare. The regular
local/Cloudflare configuration retains `staticRelease = null`.

All 19 art manifest URLs and their pinned SHA values stay unchanged. No resource
ZIP, catalog identity or original art object is repackaged for this main-game
change. Game startup HTTP requests use the current Toy version directory and
the 19 published Toy resource sources. Cloudflare remains the multiplayer
WebSocket service at `/ws/native`; it no longer supplies the Toy build metadata,
catalog, scripts or engine.

Packaging, uploading and a platform `published` status do not establish that the
formal game is serving this version. Verification must open the formal Bilibili
wrapper, inspect its actual versioned iframe URL, then check the iframe's
release marker, configuration and startup requests through the first rendered
menu. The current public release has visitor watermark disabled so anonymous
visitors can enter. Old files or a 404 at the former flat asset root do not
describe what the platform-selected version iframe serves.

On 2026-10-24, formal iframe `yuri/46835028978688-v32241/index.html` served release
`ea296e6d4a20bcc991ae`. With the test browser's app-content cache cleared and HTTP
cache disabled, startup loaded 19 manifests, 43 art parts (the skirmish plus
menu-animation subset), and the bundled engine from `www.bilibilitoy.com`.
All 79 game resource requests used that origin, the canvas reached `ready`,
the native menu rendered, and the console had no errors. HTTP cache was restored
afterward. Receipts: `validation/toy-self-contained-formal-browser-20261024.json`
and `validation/toy-resource-main-public-status-20261024.json`. This proves
formal resource activation and menu startup; battle play and Android map loading
remain separate acceptance scopes.

Independent HTTP checks matched all 19 runtime payload files byte for byte.
The ZIP also includes the font license under its original extensionless name;
Toy returns 404 for that non-runtime file. It is never requested by the game.
`validation/toy-self-contained-public-files-20261024.json` retains this exception
rather than claiming every ZIP member is directly served.

The local/Cloudflare default is `resourcePackUrls = []` in
`web-native/host-config.js`. The Toy export replaces this with the approved set.
Each entry can be a full
manifest URL, a directory ending in `/`, or `{url, sha256}` binding a manifest
to its recorded SHA. All complementary shards must be supplied together. A
missing or incompatible shard fails before art loading instead of silently
treating an incomplete set as a complete mirror. Never activate preview URLs.

The public-download verifier performs 102 actual requests with no persistent
cache or fallback: 19 manifests and 83 parts, reconstructing 35 gzip/raw objects
with streaming SHA/size checks. It uses the production multipart loader, while
browser CORS remains a separate check. Results are dated under
`validation/toy-resource-public-downloads-YYYYMMDD.json`. The 2026-10-24 run
downloaded 854,335,589 part bytes and verified 1,217,267,355 decompressed bytes.
The actual Toy preview browser reached `data-werhd-stage=ready` and rendered the
native menu after preparing skirmish content; see
`validation/toy-resource-main-browser-20261024.json`. That earlier preview receipt
does not establish formal activation of the new self-contained main ZIP. It is
startup evidence, not sustained battle or multiplayer acceptance.

The tool cover/icon are rendered from the code-native SVG/HTML template
`tools/templates/resource-publish-media.html`. The isolated publishing media
are `dist/toy-resources/media/poster.png` (1200x900) and `icon.png` (512x512).
They are separate upload metadata and do not change the verified resource ZIPs.
