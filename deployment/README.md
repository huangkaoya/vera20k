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

## Upload and deploy

The configured bucket is the existing `ra2res`; no existing object is replaced.
The first command below is local validation only. An explicit `--upload` enables
remote multipart upload using the current Wrangler login. Uploads use bounded
8 MiB parts, verify each part and the completed multipart ETag, and retain resume
state in ignored `generated/upload-state/`.

```sh
npm run upload --prefix deployment
npm run upload --prefix deployment -- --upload
npm run deploy --prefix deployment
```

The default Worker has **no custom-domain route**. It can be validated on its
own Workers hostname without replacing the existing `wan.youlidefuchou.com`
Pages deployment. Attaching that domain requires access to its owning account
and an explicit change from the existing Pages routing; this configuration does
not assume that the local Wrangler account has that permission.

## Runtime boundary

`/ws/native` requires an exact same-origin `Origin` and forwards to the native
v2 coordinator Durable Object. The current bound is 64 clients / 32 two-player
rooms. It uses standard WebSockets so a connected match retains its coordinator
in memory. Deploy/restart/disconnect terminates a match, like the local adapter;
there is no unimplemented promise of resuming a partially committed game.

Cloudflare does not run the 95 MiB game WASM inside its Worker. Browsers run the
unchanged VERA client; the Worker streams assets and the coordinator admits
ordered native commands and checks matching hashes.
