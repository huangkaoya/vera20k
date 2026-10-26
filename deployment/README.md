# Native WebGPU deployment

This directory packages the complete native client for Workers, R2 and a native
protocol v3 Durable Object. It does not depend on a running Mac or Node server.
The Worker imports the same `NativeRoomCoordinator` used by the local adapter.

## Prepare and validate

Run from the repository root, after recording the final native source patch:

```sh
npm ci
npm ci --prefix deployment
npm run build:native-web
npm run package --prefix deployment
npm run types --prefix deployment
npm run check:types --prefix deployment
npm test --prefix deployment
npm run check --prefix deployment
```

Packaging requires a checked schema 2 native build. It checks the source patch,
actual JS/WASM hashes and the schema-2 content catalog before writing ignored
`generated/` output. Native source, retail archives and credentials are never
copied into the small static-assets directory. Source edits after packaging
require a new checked build/package.

The static directory contains HTML/JS/CSS/font/icon files below 25 MiB. WASM and
retail/content archives stay in R2 under
`vera20k/web-native/objects/sha256/<content-sha256>`. Unchanged archives are reused
across releases. The Worker only reads the object keys in its bundled release
manifest, serves `application/wasm`, streams full or single byte ranges, and
rejects unlisted content/retail/config/source paths. `/api/native/resources`
returns the complete catalog with `skirmish` as the default startup profile,
optional packs and a separate full startup profile. Resource URLs are immutable
`/content/objects/<sha256>` paths. The client checks compressed size/SHA,
decompresses, then checks raw size/SHA before mounting.

The browser loads `/native/werhd.js` and `/native/werhd_bg.wasm`; those exact
names are also used by the public build manifest. The older engine filenames
have no compatibility alias and return 404. The R2 key prefix above is private
storage identity: only `/content/objects/<sha256>` reaches the browser, and no
R2 key, account or bucket metadata is copied into response headers.

## Default and optional content

Build the reproducible catalog with `python3 tools/native-content.py build`
before the checked native build, then run `python3 tools/native-content.py check`.
The public catalog contains no local installation paths; the ignored
`.build/native-content/plan.json` maps exact SHA objects to read-only retail or
generated files for packaging. See [the content pipeline](../docs/native-content.md).

The default profile contains 26 files: 602,239,457 raw bytes and 279,134,944
download bytes, including all six theaters, skirmish maps, unit art and YR
audio. Campaign, cinematics, music and branding animation are optional. Campaign
depends on cinematics. The current branding animation is the approved
4,110,830-byte compressed MP4. Once the native menu is ready, a background job
automatically attempts this one verified download and installs it into a
bounded presentation-only slot for the existing native movie texture. It does
not delay game startup, reload a match, or enable campaign cinematics. The
73 MB PNG-frame stream is not published by this catalog. Theater groups currently
describe bundled content, not runtime hot-mountable packs.

The full profile preserves the original 32 retail files plus that MP4. It is an
alternative startup set because its language containers differ from the lean
ones. Optional retail additions are cached and enabled on reload; caching them
alone does not change simulation resources or the network identity. The small
menu MP4 is the presentation-only exception described above.

Packaging requires both `build.resourceManifestSha256 === catalog.identity`
and `build.contentCatalogIdentity === catalog.catalogIdentity`. The former is
the fixed default gameplay identity, also required by full; the latter pins the
entire recursively canonicalized catalog, including all optional descriptors.
The release publishes every raw/gzip object in the private plan, the raw WASM
alias `/native/werhd_bg.wasm`, and its explicit gzip transfer descriptor.
Content-addressed R2 keys deduplicate unchanged objects across releases. Gzip
objects use `application/gzip` with **no HTTP Content-Encoding**, so fetch cannot
silently decode bytes before their transfer SHA is checked. Retain old immutable
objects during rollout/rollback; a release whitelist only exposes its own keys.

## Target, authentication and upload

`target.json` is the desired deployment target: the owning Cloudflare account,
the existing `youlidefuchou-res` bucket and the `youlidefuchou` named profile.
Both Wrangler configurations explicitly pin that account and bucket. Packaging
and upload validate both configurations against the target, and the release
and upload plan also bind the account, bucket and isolated object prefix.
Old-account plans and configurations are rejected before authentication.

The first upload command below performs only local validation. It does not
resolve a profile, import Wrangler, request credentials or contact Cloudflare.
An explicit `--upload` resolves the named profile through Wrangler with inherited
token/key/email overrides removed. Credentials remain in memory, Wrangler file
logging is disabled, and the account must be readable before its token is
provided to the remote binding. The proxy does not load `.env` files. An
alternative named profile can be selected with `VERA_CLOUDFLARE_PROFILE`; it must
still access the same pinned account. Credentials are never written to upload
plans, state, receipts or error output.

Only new content-addressed keys under our prefix are uploaded. Existing keys
are reused only when their SHA/size metadata matches. No other objects, CORS or
bucket domains are changed. Uploads use bounded 8 MiB parts, verify each part and
the completed multipart ETag, and retain resume state in ignored
`generated/upload-state/<account>/<bucket>/`. Resume records include the target
identity and cannot be reused across accounts or buckets.

```sh
npm run upload --prefix deployment
npm run upload --prefix deployment -- --upload
npm run deploy --prefix deployment
```

Deployment scripts explicitly select `--profile=youlidefuchou`. Run any direct
Wrangler command from this directory with the same explicit profile. A named
profile does not itself prove permission to publish: the real R2 upload, Worker
deployment and public hostname checks remain separate acceptance steps.

## Static emergency mode executed on 2026-10-24

The local configuration now has `routes: []`, `workers_dev: false` and
`preview_urls: false`. This prevents a later deployment from reopening the
native Worker's `wan.youlidefuchou.com/*`, workers.dev or version-preview
entry points. The previous configuration is backed up at
`../../output/youlidefuchou-static-20261024/native-wrangler.before.jsonc`.
The game, resource catalog, R2 binding and Durable Object implementation are
unchanged; their public native endpoints are intentionally unavailable in
this mode.

Production has been switched to the original static `youlidefuchou-wan`
Pages deployment for `wan`, the new pure static `youlidefuchou-static` Pages
project for the root domain and `www`, and the existing `res`/`map` R2 custom
domains. The zone Worker routes are empty. The native Worker's workers.dev
and preview endpoints are confirmed disabled by API readback. The landing
Worker's root and `www` bindings were removed before attaching those domains
to Pages. The landing Pages deployment is
`ac24773d-cfd0-4e4f-9c04-231e3c7ff3d8` (`uses_functions=false`), uploaded
through QQ Browser. At cutover the root domain was active and `www` was
pending activation. Complete public/browser acceptance belongs to the
recovery task; historical native checks below do not prove current static
gameplay availability. Do not run the native transport
probe against the static fallback expecting its dynamic APIs or WebSocket
endpoint to succeed.

## Historical production topology and verification (2026-10-22)

Production was connected on 2026-10-22:

- `https://wan.youlidefuchou.com` uses zone Worker route
  `wan.youlidefuchou.com/*` to `werhd-vera-native`. The existing CNAME still
  targets `youlidefuchou-wan.pages.dev` and is now proxied by Cloudflare.
- The same Worker is available at
  `https://werhd-vera-native.chdhyc.workers.dev`. Small assets use its ASSETS
  binding; the WASM and content objects use the `youlidefuchou-res` R2 binding
  and our immutable content-addressed prefix. All game requests stay on the
  browser's selected origin, including `/ws/native` to the `NativeRooms` DO.
- The existing `youlidefuchou-wan` Pages project, custom domain and production
  deployment remain intact as the fallback. The initial native Worker version
  is `13c9cdfe-04e8-4e32-bf3c-25d7274680db`; the route ID is
  `24515d4002fc48dcbc6b87d10c9e1301` in zone
  `6af2d4065f7f473419acaf79c28899d1`.

Run the post-deployment probe against either hostname from the repository root:

```sh
npm run verify --prefix deployment -- --origin=https://werhd-vera-native.chdhyc.workers.dev
npm run verify --prefix deployment -- --origin=https://wan.youlidefuchou.com
```

The probe requires the matching local `generated/release.json`. It checks
health/build/catalog identities, shared required identity across profiles,
every published raw/gzip object's HEAD size/ETag/MIME and absent Content-Encoding,
the WERHD JS route, retired engine routes returning 404, an eight-byte WASM
Range response and gzip header, rejected missing/foreign WebSocket Origins and
a temporary two-peer native-v2 room. Its launch receipts and checksum are
synthetic; it removes its temporary rooms and does not load the engine. Both
hostnames passed the previous complete-file HTTP/transport probe at initial
cutover. A newly prepared content-catalog package needs its own upload,
deployment and matching probe; local fixture tests do not establish that it is
live. Actual WebGPU rendering,
two-browser gameplay and exit/reentry require separate browser acceptance.

## Route rollback

To restore the previous site, remove only the native Worker route identified
above and remove its `routes` entry from the local Wrangler configuration so a
later deploy cannot recreate it. Keep the Pages project, its custom domain and
the existing CNAME target intact. The CNAME can remain **proxied**; switching it
back to DNS-only is not required for rollback. Requests then fall through to
the unchanged Pages production deployment. Do not remove the R2 bucket or
unrelated objects. See the official
[route prerequisites](https://developers.cloudflare.com/workers/configuration/routing/routes/)
and [Pages migration routing guidance](https://developers.cloudflare.com/pages/migrations/migrating-from-workers/).

## Runtime boundary

`/ws/native` requires a validated same-origin or HTTPS `bilibilitoy.com`
(including proper subdomains) `Origin` and forwards to the native
v2 coordinator Durable Object. The current bound is 64 clients / 32 two-player
rooms. It uses standard WebSockets so a connected match retains its coordinator
in memory. Deploy/restart/disconnect terminates a match, like the local adapter;
there is no unimplemented promise of resuming a partially committed game.

Cloudflare does not run the game WASM inside its Worker. Browsers run the
WERHD client; the Worker streams assets and the coordinator admits
ordered native commands and checks matching hashes.

## Toy browser package

`npm run package:toy` from the repository root exports the checked public release
as a small static ZIP under `dist/toy/`. The catalog and immutable engine/art
objects remain on this Worker; the uploaded pages use package-relative host
assets and the same native game UI. HTTPS `bilibilitoy.com` and its proper
subdomains receive explicit per-origin CORS for resource GET/HEAD and bounded
preflights, and are admitted at both WebSocket boundaries. Other origins receive
no CORS permission. R2 bucket policy is unchanged. See
[the export workflow](../docs/native-toy.md).
