// A presentation-only download after the game is ready. It never changes the
// selected resource profile, reloads a running game, or installs campaign media.
const MAX_MENU_BYTES = 8 * 1024 * 1024;

export function installMenuAnimationPrefetch({catalog, store, onReady, onState = () => {}} = {}) {
  if (!store?.loadFile || typeof onReady !== 'function') throw new Error('菜单影片缺少资源适配入口');
  let disposed = false, pending, controller;
  let state = {state: 'idle', name: 'werhd-menu.mp4', bytes: 0, loadedBytes: 0, error: null};
  const snapshot = () => Object.freeze({...state});
  const publish = next => {
    state = {...state, ...next};
    try { onState(snapshot()); } catch { /* Diagnostics do not control playback. */ }
  };
  async function download() {
    try {
      const pack = catalog?.packs?.brandingAnimation, files = pack?.files;
      if (!Array.isArray(files) || files.length !== 1 || files[0].name !== 'werhd-menu.mp4'
        || pack.dependsOn?.length || !Number.isSafeInteger(files[0].bytes)
        || files[0].bytes < 16 || files[0].bytes > MAX_MENU_BYTES)
        throw new Error('当前版本缺少有效的压缩菜单影片');
      const file = files[0]; controller = new AbortController();
      publish({state: 'downloading', bytes: file.bytes, sha256: file.sha256, error: null});
      const bytes = await store.loadFile(file, {signal: controller.signal, onProgress: event => {
        if (!disposed) publish({loadedBytes: Math.min(file.bytes, event.loadedBytes ?? 0), cacheStatus: event.cacheStatus});
      }});
      if (disposed || controller.signal.aborted) return false;
      if (!(bytes instanceof Uint8Array) || bytes.length !== file.bytes) throw new Error('菜单影片内容不完整');
      // ContentStore has verified the exact catalog SHA-256 before this call.
      await onReady(bytes);
      if (disposed || controller.signal.aborted) return false;
      publish({state: 'ready', loadedBytes: bytes.length});
      return true;
    } catch (error) {
      if (!disposed) publish({state: 'unavailable', error: error instanceof Error ? error.message : String(error)});
      return false; // Optional media must never reject game startup or a battle.
    }
  }
  return Object.freeze({snapshot,
    start() { if (disposed) return Promise.resolve(false); return pending ??= download(); },
    dispose() { if (disposed) return; disposed = true; controller?.abort(); publish({state: 'disposed'}); },
  });
}
