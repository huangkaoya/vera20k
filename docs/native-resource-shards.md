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
`validation/toy-resource-public-manifests-20261024.json`. Sources remain disabled
pending the user's activation approval and target-game browser validation.
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
python3 tools/native-resource-shards-test.py
npm test
```

The current catalog produces 19 ZIPs from 83 parts covering 35 original objects.
The largest ZIP is 48,004,373 bytes. Each part is at most 16,000,000 bytes;
the browser verifies a part before streaming it into the unchanged whole-gzip
and raw-file verification path. Only art/content moves to these shards; the
checked WASM engine continues to use the existing service. The default startup
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

`staged-sources.json` and the journal's source list always retain
`enabled:false`. Canonical candidate resource bases use
`https://www.bilibilitoy.com/toy/<slug>/v2/`, never a temporary preview URL.
Uploading, review, actual public resource availability and switching the game
to Toy remain separate steps. Keep the current Cloudflare game configuration
until the user confirms approval, then verify actual public manifest/part
bytes before making the final source change.

The production default is `resourcePackUrls = []` in
`web-native/host-config.js`. Once explicitly approved, each entry can be a full
manifest URL, a directory ending in `/`, or `{url, sha256}` binding a manifest
to its recorded SHA. All complementary shards must be supplied together. A
missing or incompatible shard fails before art loading instead of silently
treating an incomplete set as a complete mirror. Never activate preview URLs.

The tool cover/icon are rendered from the code-native SVG/HTML template
`tools/templates/resource-publish-media.html`. The isolated publishing media
are `dist/toy-resources/media/poster.png` (1200x900) and `icon.png` (512x512).
They are separate upload metadata and do not change the verified resource ZIPs.
