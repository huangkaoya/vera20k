# Content delivery acceptance — 2026-10-22

Published at <https://wan.youlidefuchou.com/> with Worker version
`e4f87bfd-8a61-48ff-8ea7-fb7e60c2aa49`. Browser gameplay below ran on
`88b63973-6945-4811-92e6-062fd61e1e61`; the final publication only removes a
trailing blank line in the content-panel JavaScript. Native, catalog, Worker
logic and protocol bytes are unchanged; final static bytes are checked separately.

- Native patch: `fe3c680e9416c36b0ba219823681f90553e2cc8fda358f1ff59e59a1fca173ba`.
- Required gameplay resources: `4fe1b06b1e33cdfc84916b61706cfdad0ee307d88486b156d2b48bf3b7f78c58`.
- Content catalog: `b621aaa67a573c92931ef8411345d44d2adf05b5e9acfc07d7301261a4f67330`.
- Release manifest: `c77c8faba21e99973b26649fd799d2e6fb2224dad689451a83ebaf1bcf8fcb10`.

## Build and integrity

The final native WASM build succeeded. Root Node tests passed 100/100, Python
content tests 14/14, native core browser tests 9/9, and deployment tests 15/15.
Deployment type checking and Wrangler dry-run passed. All 70 content raw/gzip
objects were length/hash checked, including decompressed raw identity. The
twelve static resolver comparisons cover six theaters and two sidebar families;
they do not claim twelve manually played scenarios.

The exact approved H.264 menu video is 4,110,830 bytes, 431 frames at 15 fps.
The web build uses browser video decoding when this optional pack is enabled.
The former 73,492,068-byte frame archive is absent from the web content catalog;
default startup uses the first-frame poster. Actual local optional-video playback
and music-enabled startup reached the native menu without missing-theme warnings.

## Actual browser observations

The in-app browser loaded the public default profile through WebGPU. Its resource
timing contained exactly 27 content requests: 26 skirmish files totaling
279,134,944 transfer bytes and one 10,064,335-byte compressed engine. No campaign,
cinematic, music or menu-video objects were requested. A second public client
reached the menu using verified CacheStorage with zero content-object network
requests. These totals exclude HTML, JavaScript, fonts and icons.

Local two-client gameplay on `XMP29U2.MAP` used an American player with music and
menu animation enabled and a Soviet player with no optional packs. Real UI
commands moved and deployed the MCV, constructed/placed power and barracks, and
produced a GI. Both engines remained running beyond 11,000 ticks with no network
error. Explicit exit stopped both peers and returned them to the lobby.

Two public clients using the default profile entered the same native battle.
Real UI commands moved/deployed the MCV and completed power production. The
guest surrendered through the native Observe action. Both clients reached
`finished` at tick 1380 with CRC `retail:1380:c07d3c57` and no error. Sequential
running snapshots are not used as evidence of same-tick equality.
Both clients then returned to the menu, created a new room and reached another
running match. Their captured tick-241 CRC was `retail:241:cd9ce7f4` on both sides;
this second match was deliberately stopped by closing the test guest.

## Limits and evidence

The public normal-speed sample advanced 542 ticks over 92.004 seconds, about
5.89 ticks/second; local gameplay was about 20 ticks/second. The current
per-tick ordered-turn barrier remains sensitive to network round-trip latency.
This resource-delivery change does not resolve that pacing limitation.

Full/campaign plans, dependencies and objects are verified, but campaign play
and completion were not manually accepted. All six theaters remain in the
default package. Optional resources require reload; the current VFS does not
hot-mount them. Future sim-only frontend work must replace the runtime adapter
and match lifecycle; it can reuse the independent catalog, plan and store.

Detailed local receipts/screenshots are ignored under `validation/native-content-*`.
The final protected-source comparison found zero changes in all 6,252 VERA files
and 2,513 WERHD files, including their Git HEAD/status, against the existing
baseline. Build, upload, HTTP/transport and actual gameplay receipts remain
separate records.
