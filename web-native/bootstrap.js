import {ContentStore} from './content-store.js';
import {resolveContentPlan} from './content-plan.js';
import {createContentController} from './content-controller.js';
import {createNativeShellBridge} from './shell-bridge.js';
import {createWerhdRuntime} from './runtime-adapter.js';
import {installNativeLobby} from './lobby.js';
import {installPointerCapture} from './pointer-capture.js';
import {installMenuAnimationPrefetch} from './menu-animation.js';
import {createWebHost} from './host.js';
import {resourcePackUrls} from './host-config.js';
import {createResourcePackFetch} from './resource-packs.js';

const status = document.querySelector('#status'), progress = document.querySelector('#progress');
const startup = document.querySelector('#startup'), canvas = document.querySelector('#game');
const actions = document.querySelector('#startup-actions'), selectionKey = 'werhd.content.selection.v1';
const controller = new AbortController(), size = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
let runtime, pointerCapture, menuAnimation, menuAnimationState = {state: 'idle'};
let initialized = false, cacheWarning = false;
const shell = createNativeShellBridge();
const host = createWebHost();
window.addEventListener('pagehide', event => {
  if (!event.persisted) { pointerCapture?.dispose(); menuAnimation?.dispose(); shell.dispose(); }
});
function action(text, callback) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
  button.addEventListener('click', callback); return button;
}
async function json(url) {
  const response = await fetch(url, {cache: 'no-store', signal: controller.signal});
  if (!response.ok) throw new Error(`版本信息读取失败：${response.status}`);
  return response.json();
}
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
function activationAllowed() {
  if (!runtime || !initialized) return false;
  return runtime.menuActive()
    && !['loading', 'ready', 'running', 'finishing'].includes(runtime.networkStatus()?.phase);
}

try {
  if (!navigator.gpu) throw new Error('当前浏览器未提供 WebGPU，请使用支持 WebGPU 的浏览器。');
  const [build, catalog] = await Promise.all([json(host.serviceUrl('/native/build.json')), json(host.serviceUrl('/api/native/resources'))]);
  const {catalogIdentity, ...catalogBody} = catalog;
  if (catalogIdentity !== await digest(new TextEncoder().encode(JSON.stringify(canonical(catalogBody))))
    || build.contentCatalogIdentity !== catalogIdentity || build.resourceManifestSha256 !== catalog.identity)
    throw new Error('引擎与资源目录版本不一致，请重新载入游戏');
  let selection = {profile: 'skirmish', addons: []};
  try {
    const saved = JSON.parse(localStorage.getItem(selectionKey) ?? localStorage.getItem('vera.content.selection.v1'));
    if (saved) {
      resolveContentPlan(catalog, saved); selection = saved;
      // Preserve validated selections across the browser namespace change.
      localStorage.setItem(selectionKey, JSON.stringify(saved));
      localStorage.removeItem('vera.content.selection.v1');
    }
  } catch {}
  const fetchContent = await createResourcePackFetch({sources: resourcePackUrls, catalog,
    fallbackFetch: host.fetchContent, signal: controller.signal});
  const plan = resolveContentPlan(catalog, selection), store = new ContentStore({fetch: fetchContent, onCacheStatus: event => {
    if (['unavailable', 'write-failed'].includes(event.state)) cacheWarning = true;
  }});
  const content = createContentController({catalog, store,
    onState: state => shell.publish('content', state),
    initialSelection: {profile: plan.profile, addons: plan.addons}, isActivationAllowed: activationAllowed, onActivate: next => {
    if (!activationAllowed()) throw new Error('请先退出对局，再切换资源');
    const checked = resolveContentPlan(catalog, next);
    localStorage.setItem(selectionKey, JSON.stringify({profile: checked.profile, addons: checked.addons}));
    controller.abort(); location.reload();
  }});
  shell.attach('content', content);
  actions.append(action('取消下载', () => controller.abort()));
  Object.defineProperty(window, '__werhdContent', {value: Object.freeze({profile: plan.profile, addons: plan.addons,
    requiredResourceIdentity: plan.requiredResourceIdentity, catalogIdentity, files: plan.files.length,
    rawBytes: plan.totalBytes, downloadBytes: plan.downloadBytes, capabilities: plan.capabilities})});
  const engine = build.outputs?.['werhd_bg.wasm'];
  if (!engine) throw new Error('缺少游戏引擎版本信息');
  const engineFile = {name: 'werhd_bg.wasm', ...engine, url: '/native/werhd_bg.wasm'};
  status.textContent = `正在载入游戏引擎 · ${size(engine.download?.bytes ?? engine.bytes)}`;
  const engineBytes = await store.loadFile(engineFile, {signal: controller.signal, onProgress: event => {
    progress.value = Math.min(1, event.attemptWireBytes / Math.max(1, event.wireTotalBytes));
    status.textContent = event.cacheStatus === 'hit' ? '正在读取已校验的引擎缓存…'
      : `正在载入游戏引擎 ${size(event.attemptWireBytes)} / ${size(event.wireTotalBytes)}`;
  }});
  runtime = await createWerhdRuntime({moduleUrl: host.serviceUrl(`/native/werhd.js?sha256=${build.outputs['werhd.js'].sha256}`), engineBytes});
  shell.setRuntime(runtime);
  runtime.configureContent(plan.capabilities);
  const font = new FontFace('WERHD UI', `url("${host.assetUrl('fonts/FiraSansCondensed-Medium.ttf')}")`, {weight: '500'});
  document.fonts.add(await font.load());
  let cursor = 0, complete = 0, firstError;
  const progressByFile = new Map();
  const report = () => {
    const prepared = [...progressByFile.values()].reduce((sum, bytes) => sum + bytes, 0);
    progress.value = Math.min(1, prepared / Math.max(1, plan.downloadBytes));
    status.textContent = `正在准备${plan.profile === 'full' ? '完整' : '遭遇战'}素材 ${complete} / ${plan.files.length}\n${size(prepared)} / ${size(plan.downloadBytes)}\n`
      + (cacheWarning ? '浏览器缓存不可用，后续可能需要重新下载。' : '已校验资源会保留在本地缓存。');
  };
  const workers = await Promise.allSettled(Array.from({length: 2}, async () => {
    try {
      while (cursor < plan.files.length) {
        controller.signal.throwIfAborted();
        const file = plan.files[cursor++], wireBytes = file.download?.bytes ?? file.bytes;
        const bytes = await store.loadFile(file, {signal: controller.signal, onProgress: event => {
          progressByFile.set(file.sha256, event.cacheStatus === 'hit' || event.stage === 'complete'
            ? wireBytes : Math.min(wireBytes, event.attemptWireBytes)); report();
        }});
        controller.signal.throwIfAborted();
        runtime.mountResource(file.name, bytes); ++complete; progressByFile.set(file.sha256, wireBytes); report();
      }
    } catch (error) { firstError ??= error; controller.abort(); throw error; }
  }));
  if (firstError) throw firstError;
  if (workers.some(worker => worker.status === 'rejected')) throw new Error('素材准备失败');
  status.textContent = '正在初始化画面…';
  const ready = new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (canvas.dataset.werhdStage === 'ready') { observer.disconnect(); resolve(); }
      else if (canvas.dataset.werhdStage === 'error') { observer.disconnect(); reject(new Error(canvas.dataset.werhdError ?? '游戏初始化失败')); }
    });
    observer.observe(canvas, {attributes: true, attributeFilter: ['data-werhd-stage', 'data-werhd-error']});
  });
  const lobby = installNativeLobby({native: runtime.network, canvas, socketUrl: host.serviceUrl('/ws/native'), onState: state => shell.publish('lobby', state)});
  shell.attach('lobby', lobby);
  runtime.start(canvas);
  Object.defineProperty(window, '__werhdNative', {value: Object.freeze({sourceRevision: runtime.sourceRevision(),
    diagnostics: runtime.diagnostics, networkStatus: runtime.networkStatus,
    pointerCaptureStatus: () => pointerCapture?.snapshot(),
    menuAnimationStatus: () => structuredClone(menuAnimationState)})});
  await ready; initialized = true; startup.hidden = true; content.refresh(); canvas.focus();
  pointerCapture = installPointerCapture({canvas,
    getState: () => ({pointerCaptureAllowed: runtime.pointerCaptureAllowed()})});
  menuAnimation = installMenuAnimationPrefetch({catalog, store,
    onReady: bytes => runtime.installMenuAnimation(bytes),
    onState: state => { menuAnimationState = state; content.refresh(); }});
  menuAnimation.start();
} catch (error) {
  controller.abort();
  pointerCapture?.dispose(); menuAnimation?.dispose();
  shell.dispose();
  status.textContent = error?.name === 'AbortError' ? '下载已取消，已完成校验的缓存会保留。'
    : `游戏启动失败：${error instanceof Error ? error.message : String(error)}`;
  progress.hidden = true; actions.replaceChildren(action('重新载入并重试', () => location.reload()));
  if (error?.name !== 'AbortError') console.error(error);
}
