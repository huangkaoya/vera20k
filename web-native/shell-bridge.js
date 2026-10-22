const surfaces = new Set(['content', 'lobby']);

// The bridge carries semantic snapshots and actions only. It creates no DOM
// nodes and has no drawing or simulation-command API.
export function createNativeShellBridge({eventTarget = globalThis.window, onError = console.error} = {}) {
  if (!eventTarget?.addEventListener || !eventTarget?.removeEventListener) throw new Error('缺少原生菜单事件入口');
  const controllers = new Map(), pending = new Map();
  let runtime, disposed = false;
  const dispatch = detail => {
    if (disposed || !detail || !surfaces.has(detail.surface) || typeof detail.action !== 'string' || detail.action.length > 32) return;
    const controller = controllers.get(detail.surface);
    if (!controller) return;
    try { Promise.resolve(controller.dispatch(detail)).catch(onError); }
    catch (error) { onError(error); }
  };
  const listener = event => dispatch(event.detail);
  eventTarget.addEventListener('werhd-shell-action', listener);
  return {
    attach(surface, controller) {
      if (disposed || !surfaces.has(surface) || typeof controller?.dispatch !== 'function') throw new Error('原生菜单适配器无效');
      controllers.set(surface, controller);
    },
    publish(surface, snapshot) {
      if (disposed) return;
      if (!surfaces.has(surface) || !snapshot || typeof snapshot !== 'object') throw new Error('原生菜单状态无效');
      const value = JSON.parse(JSON.stringify(snapshot)); pending.set(surface, value);
      runtime?.updateShell({schema: 1, [surface]: value});
    },
    setRuntime(value) {
      if (disposed || typeof value?.updateShell !== 'function') throw new Error('缺少原生菜单接口');
      runtime = value;
      if (pending.size) runtime.updateShell({schema: 1, ...Object.fromEntries(pending)});
    },
    dispatch,
    dispose() {
      if (disposed) return; disposed = true;
      eventTarget.removeEventListener('werhd-shell-action', listener);
      for (const controller of controllers.values()) controller.dispose?.();
      controllers.clear(); pending.clear(); runtime = undefined;
    },
  };
}
