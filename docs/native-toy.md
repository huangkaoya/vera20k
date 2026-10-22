# Toy static export

Run `npm run package:toy` after the checked browser build has been deployed to
`https://wan.youlidefuchou.com`. It checks that the public build and complete
resource catalog match the local checked build, then writes
`dist/toy/werhd-toy-<patch>-<contents>.zip`, a SHA receipt and `dist/toy/web/`.
The ZIP has `index.html` at its root and contains only the browser host scripts,
icon, UI font and release information. It contains no login integration.

The visible game, settings, loading image, touch HUD, resource manager and lobby
remain the native game UI. Only the invisible host configuration points to the
existing Cloudflare service. Original catalog URLs and all integrity checks
remain intact. Engine JS/WASM, 26 default skirmish resources, optional campaign,
cinematics and music continue to download from Cloudflare. The small menu MP4
retains its automatic background attempt. Large assets are not duplicated in
the upload ZIP. Font/icon/script references resolve relative to their packaged
module, including a Toy preview subdirectory.

The Worker admits HTTPS `bilibilitoy.com` and its dot-delimited subdomains for
resource CORS and both WebSocket admission boundaries. No wildcard CORS,
credentials, other domains or R2 bucket-wide policy is needed. The normal
Cloudflare/local host still defaults to its own origin. A Toy-side CSP, iframe
permission or unavailable WebGPU must be checked in the actual Toy preview;
local static loading and HTTP/transport probes do not establish platform
acceptance. This workflow creates an upload artifact only; it does not upload,
submit for review or publish a Toy.

The official Toy static doctor reports no errors for this export. Its one
advisory is that the small host JS filenames have no content fingerprint, so
those scripts may download again after a Toy update. Large remote objects
already use SHA filenames and retain the verified content cache.
