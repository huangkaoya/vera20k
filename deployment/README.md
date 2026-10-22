# Native WebGPU deployment

This directory packages the complete native client for Workers, R2 and a native
protocol v2 Durable Object. It does not depend on a running Mac or Node server.
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
actual JS/WASM hashes and the canonical retail manifest before writing ignored
`generated/` output. Native source, retail archives and credentials are never
copied into the small static-assets directory. Source edits after packaging
require a new checked build/package.

The static directory contains HTML/JS/CSS/font/icon files below 25 MiB. WASM and
retail archives stay in R2 under
`vera20k/web-native/objects/sha256/<content-sha256>`. Unchanged archives are reused
across releases. The Worker only reads the object keys in its bundled release
manifest, serves `application/wasm`, streams full or single byte ranges, and
rejects unlisted retail/config/source paths. Resource URLs carry their SHA and
the client still checks the complete bytes before mounting them.

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

## Production topology and verification

Production was connected on 2026-10-22:

- `https://wan.youlidefuchou.com` uses zone Worker route
  `wan.youlidefuchou.com/*` to `werhd-vera-native`. The existing CNAME still
  targets `youlidefuchou-wan.pages.dev` and is now proxied by Cloudflare.
- The same Worker is available at
  `https://werhd-vera-native.chdhyc.workers.dev`. Small assets use its ASSETS
  binding; the WASM and 32 retail files use the `youlidefuchou-res` R2 binding
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
health/build/resource identities, every object's HEAD size/ETag/MIME, an
eight-byte WASM Range response, rejected missing/foreign WebSocket Origins and
a temporary two-peer native-v2 room. Its launch receipts and checksum are
synthetic; it removes its temporary rooms and does not load the engine. Both
hostnames passed this HTTP/transport probe at cutover. Actual WebGPU rendering,
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

`/ws/native` requires an exact same-origin `Origin` and forwards to the native
v2 coordinator Durable Object. The current bound is 64 clients / 32 two-player
rooms. It uses standard WebSockets so a connected match retains its coordinator
in memory. Deploy/restart/disconnect terminates a match, like the local adapter;
there is no unimplemented promise of resuming a partially committed game.

Cloudflare does not run the 95 MiB game WASM inside its Worker. Browsers run the
unchanged VERA client; the Worker streams assets and the coordinator admits
ordered native commands and checks matching hashes.
