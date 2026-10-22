// The current native presentation is an adapter behind this boundary. Content
// download/cache code and a future lobby do not import wasm-bindgen exports.
export async function createWerhdRuntime({moduleUrl, engineBytes, importModule = url => import(url)}) {
  if (!moduleUrl || !(engineBytes instanceof Uint8Array)) throw new Error('缺少已校验的游戏引擎');
  const native = await importModule(moduleUrl);
  await native.default({module_or_path: engineBytes});
  let started = false, configured = false;
  const beforeStart = () => { if (started) throw new Error('对局运行期间不能变更资源，请重新载入游戏'); };
  const network = Object.freeze(Object.fromEntries([
    'network_start', 'network_leave', 'network_receive', 'network_drain_outbox', 'network_status',
  ].map(name => [name, (...args) => native[name](...args)])));
  return Object.freeze({
    configureContent(capabilities) {
      beforeStart();
      native.configure_content(JSON.stringify({schema: 1, ...capabilities}));
      configured = true;
    },
    mountResource(name, bytes) {
      beforeStart();
      if (!(bytes instanceof Uint8Array)) throw new Error('资源必须是已校验的二进制内容');
      native.mount_resource(name, bytes);
    },
    start(canvas) {
      beforeStart();
      if (!configured) throw new Error('请先确认本次启动的资源能力');
      native.start_browser(canvas);
      started = true;
    },
    installMenuAnimation(bytes) {
      if (!started) throw new Error('请先初始化游戏画面');
      if (!(bytes instanceof Uint8Array)) throw new Error('菜单动画必须是已校验的二进制内容');
      native.install_menu_animation(bytes);
    },
    network,
    updateShell: snapshot => native.browser_shell_update(JSON.stringify(snapshot)),
    sourceRevision: () => native.source_revision(),
    diagnostics: () => native.browser_diagnostics?.(),
    pointerCaptureAllowed: () => started && native.browser_pointer_capture_allowed?.() === true,
    menuActive: () => started && native.browser_menu_active?.() === true,
    networkStatus: () => native.network_status(),
  });
}
