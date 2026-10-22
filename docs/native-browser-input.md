# Native browser input and presentation

The browser adapter has no visible controls. Native app owners render menus,
the faction HUD, touch controls, shortcut editor and loading screen. Simulation
commands continue through the same native input dispatcher.

## Pointer capture and movement

`app/input/browser_cursor.rs` owns capture eligibility. Only active battlefield
input can capture: pause/settings and other menus, shortcut editing, network
wait, results, touch input, focus loss and hidden pages release it. The native
app pass publishes a derived policy bit. A lightweight WASM getter reads it
synchronously without enabling full unit/terrain acceptance diagnostics.
`web-native/pointer-capture.js` consumes it before a trusted mouse gesture,
so opening a menu cannot use an old battlefield snapshot to swallow its click.
The engagement click only captures. Esc releases, and the next battlefield
click can capture again. Rejected/unsupported capture leaves ordinary input
available. Late grants after focus, menu or lifetime changes are revoked.
Resource activation likewise reads a cheap native menu-state bit. Full
diagnostics are enabled only when explicitly requested for acceptance.

Locked absolute coordinates stay at the browser's anchor; only relative device
motion updates VERA's software cursor. Winit's pinned web backend already
converts DOM movement to physical window pixels. Therefore:

```
window_delta = physical_device_delta * mouse_sensitivity_percent / 100
source_delta = window_delta / tactical_zoom_scale
css_delta = window_delta / device_pixel_ratio
```

Each factor is applied once, with no frame-time multiplier. Before dispatching
the already integrated window point, the browser route resets the shared OS
absolute-motion history. Otherwise a letterbox clamp can leave that history
outside the visible cursor and amplify the next movement/reversal. The native
production pointer-resolution tests exercise this path at DPR 1/2/3 and
different gains/zoom scales. This follows the existing WERHD relative-input
pattern of integrating movement once and clamping, without modifying WERHD.

The native in-game Options page offers **25%–400%** sensitivity in 5% steps,
default **100%**, plus a reset button. The existing accepted-options transaction
persists `[VERA] MouseSensitivityPercent` through the browser storage provider.
This setting affects captured relative movement only; map scroll rate, ordinary
menu coordinates and simulation speed keep their own existing settings.

For bounded measurements, `window.__veraNative.diagnostics().pointerMotion`
reports input sample count, accumulated physical input, actual applied window
delta after projection/clamping, gain, window scale and zoom scale. Compare two
snapshots over a one-direction motion away from screen/letterbox edges. Applied
window delta divided by physical input should equal the configured gain there;
clamps intentionally reduce that ratio. Browser/OS acceleration is already in
the incoming movement and is not calibrated by these totals. For an otherwise
consistent speed mismatch, a practical correction is current sensitivity times
desired distance divided by observed distance, rounded to a 5% step.

## Touch and HUD

WASM compiles the existing native touch translator/gesture/HUD owners. Browser
touch capability or a real touch event enables the touch route; mouse-only web
keeps normal desktop map input. Long press, joystick, three nearby actions,
two-finger cancel/pan and icon shortcut editing use the existing native owners.
The custom faction sidebar/footer are also enabled for desktop web, with their
matching hit geometry and centered footer controls. Desktop web omits the
joystick/ring controls. This changes presentation/input, not simulation rules.

## Loading and optional menu animation

Start Skirmish immediately commits the native loading screen instead of waiting
for the menu exit animation. The loader submits its native backdrop/progress,
waits for GPU submission and browser paint opportunities, then prepares the map.
The final loading frame stays visible until the first battlefield submission;
the WASM transition does not deliberately clear it to black.

After the menu is ready, a nonblocking job attempts only the verified 4,110,830 B
branding MP4. Size/SHA validation and the existing content cache precede installing
it into a bounded presentation slot. It neither mounts campaign content nor
changes the match resource identity. Failure leaves the static native poster.

`native:update` includes the browser-presentation regression gate alongside the
network and WASM gates; the recorded binary patch retains these changes across
an upstream candidate merge. Physical-device input and browser capture support
remain runtime acceptance steps in addition to unit tests.
