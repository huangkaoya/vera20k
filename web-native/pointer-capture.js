// Browser-only capability adapter. Rust owns the visible cursor, hit tests and
// edge scrolling; winit forwards locked relative motion to that same owner.
// Pointer Lock requires a mouse engagement gesture and always permits Esc exit.
// https://www.w3.org/TR/pointerlock-2/
export function installPointerCapture({canvas, getState, document: doc = globalThis.document,
  window: win = globalThis.window, setInterval: schedule = globalThis.setInterval,
  clearInterval: unschedule = globalThis.clearInterval} = {}) {
  if (!canvas || typeof getState !== 'function' || !doc || !win) throw new Error('缺少鼠标锁定适配入口');
  let disposed = false, pending = false, suppressCompatibility = false;
  let requestEpoch = 0, failedAttempt = false, error = null;
  let authorizedEpoch = null, legacyPending = false, focused = true;
  const swallowedPointers = new Set(), listeners = [];
  const on = (target, type, listener) => {
    target.addEventListener(type, listener, true);
    listeners.push(() => target.removeEventListener(type, listener, true));
  };
  const locked = () => doc.pointerLockElement === canvas;
  const supported = () => typeof canvas.requestPointerLock === 'function';
  const snapshot = () => Object.freeze({supported: supported(), locked: locked(), pending,
    error: error ? Object.freeze({...error}) : null});
  function eligible() {
    if (disposed || doc.hidden || !focused || (typeof doc.hasFocus === 'function' && !doc.hasFocus())) return false;
    try {
      const state = getState();
      // Rust owns every battlefield/menu/dialog admission gate. Missing or old
      // snapshots fail closed rather than independently guessing from mode.
      return state?.pointerCaptureAllowed === true;
    } catch { return false; }
  }
  function swallow(event) { event.preventDefault(); event.stopImmediatePropagation(); }
  function reject(reason, token = requestEpoch) {
    if (disposed || token !== requestEpoch) return;
    pending = false; failedAttempt = true; authorizedEpoch = null;
    error = {name: typeof reason?.name === 'string' ? reason.name.slice(0, 80) : 'PointerLockError',
      message: typeof reason?.message === 'string' ? reason.message.slice(0, 400) : 'Browser rejected pointer lock'};
  }
  function release() {
    ++requestEpoch; failedAttempt = false; authorizedEpoch = null;
    pending = false; swallowedPointers.clear(); suppressCompatibility = false;
    if (locked()) { try { doc.exitPointerLock(); } catch {} }
  }
  function refresh() { if (!eligible()) release(); }
  on(canvas, 'pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.isTrusted === false || locked() || !eligible()
      || !supported() || pending || failedAttempt) return;
    // The engagement click acquires only. In particular, reacquiring after Esc
    // must not also order units or press whichever in-game dialog is underneath.
    swallowedPointers.add(event.pointerId); suppressCompatibility = true; swallow(event);
    pending = true; error = null;
    const token = ++requestEpoch;
    authorizedEpoch = token;
    try {
      canvas.focus?.({preventScroll: true});
      const result = canvas.requestPointerLock();
      if (typeof result?.then === 'function') {
        result.then(() => {
          // A host may grant the request after focus loss, native menu entry,
          // or disposal. That earlier gesture no longer authorizes capture.
          if (disposed || token !== requestEpoch || !eligible()) {
            if (locked()) { try { doc.exitPointerLock(); } catch {} }
          }
        }, reason => reject(reason, token));
      } else legacyPending = true;
    } catch (reason) { reject(reason, token); }
  });
  for (const type of ['pointerup', 'pointercancel']) on(canvas, type, event => {
    if (!swallowedPointers.delete(event.pointerId)) return;
    swallow(event);
  });
  for (const type of ['mousedown', 'mouseup', 'click', 'contextmenu']) on(canvas, type, event => {
    if (!suppressCompatibility) return;
    swallow(event);
    if (type === 'click' || type === 'contextmenu') suppressCompatibility = false;
  });
  on(doc, 'pointerlockchange', () => {
    pending = false; legacyPending = false;
    if (locked()) {
      if (authorizedEpoch !== requestEpoch || !eligible()) { release(); return; }
      failedAttempt = false; error = null;
    } else authorizedEpoch = null;
    refresh();
  });
  on(doc, 'pointerlockerror', () => {
    legacyPending = false;
    if (authorizedEpoch === null) return;
    if (!error) reject();
    else { pending = false; failedAttempt = true; }
  });
  on(doc, 'visibilitychange', refresh);
  on(win, 'blur', () => { focused = false; release(); });
  on(win, 'focus', () => { focused = true; });
  const timer = schedule(refresh, 100);
  return {snapshot, dispose() {
    if (disposed) return;
    disposed = true; unschedule(timer); release();
    for (const remove of listeners) remove();
    if (legacyPending) {
      // Void-returning implementations have no Promise to observe after
      // disposal. Retain only this bounded completion guard until their
      // outstanding request grants/errors; no input listener survives.
      const clear = () => {
        doc.removeEventListener('pointerlockchange', lateChange, true);
        doc.removeEventListener('pointerlockerror', clear, true);
      };
      const lateChange = () => {
        if (!locked()) return;
        try { doc.exitPointerLock(); } catch {}
        clear();
      };
      doc.addEventListener('pointerlockchange', lateChange, true);
      doc.addEventListener('pointerlockerror', clear, true);
    }
  }};
}
