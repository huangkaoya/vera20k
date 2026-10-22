# Native upstream candidates and network compatibility

`native:sync` reconstructs the pinned integrated source plus its recorded binary
browser patch. Updating a moving upstream is a different operation. The native
candidate updater has three explicit phases: stage, validate and promote. It
does not run on a schedule and does not publish a deployment.

## Ownership and merge model

The upstream simulation continues to own movement, production, combat, RNG and
world advancement. Our network layer owns input sealing, future turn buffers,
ordered delivery and checksum transport. It submits the same ordered native
commands with assigned execution ticks; it does not implement another world.
The small simulation integration seams, WASM platform changes and app network
adapter remain reviewable in `patches/native-client.patch`.

The integrated source contains local branding and fork customisations as well
as upstream history. An update therefore merges a new source commit **into the
existing integrated commit**. It never replaces the integrated tree with a bare
upstream export. A second three-way merge combines that candidate baseline with
the old recorded browser adaptation branch, using the old integrated baseline
as their common ancestor. Both merges retain conflict reports. A conflict is a
failed candidate, not an instruction to overwrite or silently re-record code.

The selected source's previously pinned commit must be an ancestor of both the
current integrated baseline and the new source commit. A rewritten/divergent
source history needs explicit review outside this automatic path.

## Stage

Commit owned changes and record the native patch first. The stable project must
have no tracked or untracked edits, and `native:check` must pass.

```sh
npm run native:update -- stage --source upstream --ref main
```

Use `--source origin` to update the fork lineage instead. `--ref` is required;
choose the branch/ref deliberately. `--remote` may name an explicit HTTPS fork
URL without credentials; omission uses the selected URL in
`native-source.lock.json`. No sibling checkout or `localSource.path` is opened,
fetched, reset, compiled or written.

Stage creates `.build/native-updates/<candidate-id>/project`, with a private Git
object store for merge results and an archive `native-client`. The object store
can read the existing owned `.build/vera-upstream` objects. Host code is copied
from the committed project, excluding the historical `vendor` tree and generated
caches. Large dependencies and compiler caches are reused within this project
at validation time; source files are independent copies. Stage records:

- Old stable source, host-code and three lock/patch file identities.
- Selected source URL/ref, old/new source revisions and integrated commit.
- New baseline per-file hashes and a newly generated browser patch/lock.
- The candidate's exact source and lock identities.

The current stable `native-client` and locks remain unchanged. Conflicts and
other failures leave their candidate report under `.build/native-updates`.
Baseline, adaptation and merged candidate commits have explicit retention refs
under `refs/native-update/`; the stable mirror also pins its borrowed baseline.
Reflog expiration and ordinary Git GC therefore cannot discard the commits
needed for later patch recording or reconstruction.

## Automatic candidate gates

```sh
npm run native:validate -- <candidate-id>
```

Validation runs in the candidate project, not against a moving stable source:

1. `native-source.py check` verifies the candidate baseline/patch contract.
2. Node network, shard routing, idle cleanup, bounded load-tool integration,
   lobby admission and adapter contract tests run. Load-tool integration uses
   a small local fixture; it does not manufacture public 100-user acceptance.
   A separate browser presentation gate checks mouse capture and the verified
   background menu-video download, without requiring a visible DOM overlay.
3. The controlled-delay network regression runs separately. This tests the real
   coordinator with simulated transport timing, not an actual engine battle.
4. `cargo test --lib browser_network` tests the production Rust pipeline module.
5. A native browser-input gate runs the production pointer projection, mouse
   gain/settings/persistence and touch/HUD regression tests in both client and
   core crates. This protects the browser adaptation while simulation evolves.
6. `build:native-web` builds the candidate WASM and checks source identity before
   and after compilation.

Every gate writes a log and digest. After each command, the updater checks that
candidate and stable source/locks/host code have not drifted. A failed command
records `ok:false`; there is no CLI flag to bypass a failed automatic gate.
The CLI uses fixed command arrays, not a shell or an untrusted command string.

`node_modules`, `.build/cargo` and `.build/wasm-tools` may be shared from the
owned stable project's caches. Their contents are not source identity or proof
of gameplay. Every gate receives an explicit `CARGO_TARGET_DIR` pointing at the
candidate's `.build/cargo`, so the direct native test does not create a separate
`native-client/target` cache. Validation needs the usual installed toolchain and local retail
assets; unavailable prerequisites stop the candidate without promotion.

## Actual engine acceptance and promotion

Build/transport tests do not establish gameplay compatibility. Test the exact
candidate build, then supply a JSON runtime receipt:

```json
{
  "schema": 1,
  "candidate": "candidate-ID-FROM-STAGE",
  "sourceIdentity": {"locks": {}, "source": "COPY-FROM-candidate.json"},
  "checks": {
    "sameCandidateNativeWasmReplay": true,
    "twoClientChecksums": true,
    "latencyTps": true,
    "finishAndReentry": true
  },
  "evidence": "Paths to exact build IDs, replay/CRC/timing records and browser captures"
}
```

Copy the **complete** `sourceIdentity` object from `candidate.json`; the shortened
example above is not a passing receipt. This is an explicit acceptance record,
not a mechanism which automatically proves that tests occurred. Its author must
retain the cited evidence and accurately state the coverage. No `--manual-pass`
flag manufactures a successful receipt.

Required runtime coverage:

- The same candidate simulation replay produces matching native/WASM shared
  state. New upstream rules may legitimately change old hashes: compare the same
  new simulation across runtimes, not new-vs-old versions as a universal golden.
- Two actual clients agree on committed frame checksums and execute commands
  once, including delayed inputs, ending and entering another match.
- Controlled public-like RTT/jitter preserves the selected logical speed within
  measured tolerance. Report input latency separately from simulation TPS.
- Old build/protocol/resource identities cannot mix into one admitted match.

```sh
npm run native:update -- promote <candidate-id> --runtime-receipt /absolute/path/runtime-receipt.json
```

Promotion requires passing current automatic gates and the receipt bound to the
same candidate. It also rechecks stable source/locks/host code for drift. The new
baseline commit is imported into the owned `.build/vera-upstream` object store,
with explicit baseline refs retaining both the old and new commits,
then source plus all three lock/patch files are replaced in a journaled
transaction. An exception restores the previous source and every lock. An
interrupted process blocks another update until recovery:

```sh
npm run native:update -- recover <candidate-id>
```

The old source is retained under the candidate's `stable-backup` after success;
promotion does not delete a sibling project or publish a site. Review/commit the
result and publish through the ordinary release checks. Old accepted builds
remain the active deployment until that separate release step completes.

## Updater regression tests

```sh
npm run native:test-update
```

The mini-Git fixtures use no network, real upstream, retail data or Rust build.
They exercise actual Git three-way merges, retaining local customisations,
adaptation conflicts, failed validation, candidate/source drift, promotion
rollback and successful new baseline/patch reconstruction. A fixture runtime
receipt is labelled synthetic and does not count as game acceptance.
An additional regression expires reflogs and runs real `git gc --prune=now`
before and after promotion, then verifies/records/reconstructs the source again.
