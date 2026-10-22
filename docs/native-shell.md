# Native browser service pages

Resource management and the two-player lobby are Rust shell pages, rendered by
`native-client/src/app/browser_shell.rs` and its content/lobby view modules.
They share the original shell background, button/checkbox atlases, bitmap font,
software cursor and GPU presentation. Routes are mutually exclusive with other
native menu pages; the match screen remains the ordinary VERA battlefield.

The web host has no visible resource/lobby DOM, CSS layer, image of a webpage,
or independent control layout. First-start loading text is still HTML because
the engine and its font/art are not mounted yet.

## Hidden bridge

The wasm export `browser_shell_update` accepts JSON with `schema:1` and an
optional `content` or `lobby` snapshot. Rust queues these receipts for its app
pass; JavaScript cannot mutate the live UI owner during an input callback.
Snapshots do not contain simulation commands. A background content update does
not open a page or change the mounted content profile.

Rust handles layout, press/release matching, hover, focus, editing, selection
controls and all visible labels. User intents leave the shell through the
`vera-shell-action` custom event: `{surface:'content'|'lobby',action,...}`.
`web-native/shell-bridge.js` routes them to the hidden controllers and forwards
their detached semantic snapshots back to Rust.

`content-controller.js` reuses the independent content plan/store, including
recursive dependencies, alternative full/skirmish mounting views, verified
downloads, cancellation, quota notices and a final activation guard. Downloading
a pack alone does not enable it; activation persists a small selection and
reloads before resources are mounted.

`lobby.js` uses the native-v3 buffered transport, server-authoritative room/roster,
initial loading barrier, ordered outbox, background service wakeups, finished
acknowledgment and connection epochs. It exposes `dispatch` and `onState`, creates
no visible elements, and keeps transport decisions out of the renderer. The
native shell never manufactures a joined room, ready player or started match.

## Validation

Node tests cover the controller/bridge contracts and the existing real
WebSocket protocol. Rust tests cover DTO parsing, native layout and UI actions.
These tests do not replace screenshots and actual canvas input: validate text
entry, selections, downloading/cancelling/activation, both players entering a
match, result return and another match. Record current build/patch identity and
gameplay acceptance separately from static packaging and HTTP probes.
