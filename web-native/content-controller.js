import {resolveContentPlan} from './content-plan.js';

const PACKS = {
  campaign: ['战役资源', '原版战役地图与相关内容，包含对应的过场影片。'],
  cinematics: ['过场影片', '原版剧情与过场影片。'],
  music: ['原版音乐', '完整的原版背景音乐。'],
  brandingAnimation: ['菜单动画', '王二火大品牌菜单动画。'],
};
const key = file => file.sha256.toLowerCase();
const wireBytes = files => files.reduce((sum, file) => sum + (file.download?.bytes ?? file.bytes), 0);
const rawBytes = files => files.reduce((sum, file) => sum + file.bytes, 0);

// No DOM, rendering, input, or engine imports. Rust owns the visible resource
// page; this controller only selects, downloads and verifies content plans.
export function createContentController({catalog, store, onState, onActivate,
  isActivationAllowed = () => true, initialSelection = {profile: 'skirmish', addons: []},
  setInterval: schedule = globalThis.setInterval, clearInterval: unschedule = globalThis.clearInterval} = {}) {
  if (catalog?.schema !== 2 || !store?.prefetch || typeof onActivate !== 'function' || typeof onState !== 'function')
    throw new Error('资源管理缺少有效的内容目录或适配入口');
  const packs = catalog.packs ?? {}, initial = resolveContentPlan(catalog, initialSelection);
  resolveContentPlan(catalog, {profile: 'full'});
  const dependencies = new Map(Object.keys(packs).map(id => [id, resolveContentPlan(catalog, {addons: [id]}).addons]));
  const state = {profile: initial.profile, addons: new Set(initial.addons), open: false,
    job: null, verified: new Set(), message: '', error: false, activating: false};
  let disposed = false, epoch = 0, watch = null, watchEpoch = 0, lastAllowed;

  function allowed() { try { return isActivationAllowed() === true; } catch { return false; } }
  function included(id) {
    const profile = new Map(catalog.profiles[state.profile].files.map(file => [file.name.toLowerCase(), key(file)]));
    return packFiles(id).every(file => profile.get(file.name.toLowerCase()) === key(file));
  }
  function packFiles(id) {
    if (!dependencies.has(id)) throw new Error('当前版本未提供该资源包');
    const files = new Map();
    for (const dependency of dependencies.get(id)) for (const file of packs[dependency].files) files.set(key(file), file);
    return [...files.values()];
  }
  function selection() {
    return resolveContentPlan(catalog, {profile: state.profile, addons: [...state.addons].filter(id => !included(id))});
  }
  function cached(file) { return store.cacheStatus?.(file) ?? 'unknown'; }
  function cacheLabel(files) {
    const statuses = files.map(cached);
    if (statuses.length && statuses.every(value => ['hit', 'stored'].includes(value))) return '已校验缓存';
    if (statuses.some(value => ['unavailable', 'write-failed'].includes(value))) return '缓存不可用 · 未安装';
    if (statuses.some(value => ['hit', 'stored'].includes(value))) return '部分已缓存';
    return '尚未检查缓存';
  }
  function verified(files) { return files.length > 0 && files.every(file => state.verified.has(key(file)) || ['hit', 'stored'].includes(cached(file))); }
  function snapshot() {
    const selected = selection(), selectedPacks = new Set(selected.addons), activationAllowed = allowed();
    const card = (id, title, description, files, extra = {}) => ({id, title, description,
      bytes: wireBytes(files), rawBytes: rawBytes(files), cached: cacheLabel(files), included: false, checked: false, ...extra});
    return {schema: 1, open: state.open, profile: state.profile, addons: selected.addons,
      profiles: ['skirmish', 'full'].map(id => card(id, id === 'skirmish' ? '默认遭遇战' : '完整内容',
        id === 'skirmish' ? '对战所需美术与音效，不含战役。' : '包含战役、过场影片、音乐与菜单动画。',
        catalog.profiles[id].files, {checked: state.profile === id})),
      packs: Object.entries(packs).map(([id, pack]) => {
        const [title, description] = PACKS[id] ?? [pack.title ?? id, '可选资源包。'];
        return card(id, title, description, packFiles(id), {included: included(id), checked: included(id) || selectedPacks.has(id)});
      }), selection: {bytes: selected.downloadBytes, rawBytes: selected.totalBytes, files: selected.files.length},
      downloading: !!state.job, activating: state.activating, activationAllowed,
      canActivate: !state.job && !state.activating && activationAllowed && verified(selected.files),
      job: state.job ? {title: state.job.title, file: state.job.progress?.file?.name ?? '',
        completedFiles: state.job.progress?.completedFiles ?? 0, totalFiles: state.job.progress?.totalFiles ?? 0,
        wireBytes: state.job.progress?.wireBytes ?? 0, wireTotalBytes: state.job.progress?.wireTotalBytes ?? 0,
        totalWireBytes: state.job.progress?.totalWireBytes ?? 0, transferredWireBytes: state.job.progress?.transferredWireBytes ?? 0,
        stage: state.job.progress?.stage ?? 'cache'} : null,
      message: state.message, error: state.error};
  }
  function publish() {
    if (disposed) return;
    const next = snapshot(); lastAllowed = next.activationAllowed; onState(next);
  }
  function stopWatch() { ++watchEpoch; if (watch !== null) unschedule(watch); watch = null; }
  function startWatch() {
    if (watch !== null) return;
    const token = ++watchEpoch; lastAllowed = allowed();
    watch = schedule(() => {
      if (disposed || !state.open || token !== watchEpoch) return;
      if (allowed() !== lastAllowed) publish();
    }, 250);
  }
  function report(error) { state.message = error instanceof Error ? error.message : String(error); state.error = true; publish(); }
  async function download(id) {
    if (disposed || state.job || state.activating) return;
    let files, title;
    if (id === 'selection') { files = selection().files; title = '所选内容'; }
    else if (id?.startsWith('profile:')) {
      const profile = id.slice(8); files = resolveContentPlan(catalog, {profile}).files;
      title = profile === 'full' ? '完整内容' : '默认遭遇战';
    } else { files = packFiles(id); title = PACKS[id]?.[0] ?? id; }
    const token = ++epoch, controller = new AbortController();
    state.job = {title, controller, progress: null}; state.message = ''; state.error = false; publish();
    try {
      const result = await store.prefetch(files, {signal: controller.signal, concurrency: 2, onProgress: progress => {
        if (disposed || token !== epoch || controller.signal.aborted) return;
        state.job.progress = progress; publish();
      }});
      if (disposed || token !== epoch || controller.signal.aborted) return;
      for (const file of files) state.verified.add(key(file));
      state.message = result.installed ? `${title}已下载并校验缓存，重新载入后启用。`
        : `${title}已校验，但浏览器缓存不可用。重新载入时将再次下载。`;
    } catch (error) {
      if (disposed || token !== epoch) return;
      state.error = !controller.signal.aborted;
      state.message = controller.signal.aborted ? '下载已取消，已校验的缓存会保留。'
        : `下载失败：${error instanceof Error ? error.message : String(error)}。可重试。`;
    } finally { if (!disposed && token === epoch) { state.job = null; publish(); } }
  }
  async function activate() {
    if (disposed || state.job || state.activating) return;
    if (!allowed()) { report('请先退出对局或加载流程，再切换资源。'); return; }
    const selected = selection();
    if (!verified(selected.files)) { report('请先下载并校验所选内容。'); return; }
    const token = ++epoch; state.activating = true; state.message = '正在切换资源并重新载入…'; state.error = false; publish();
    try {
      if (!allowed()) throw new Error('请先退出对局，再切换资源');
      await onActivate({profile: selected.profile, addons: selected.addons});
    } catch (error) { if (!disposed && token === epoch) report(error); }
    finally { if (!disposed && token === epoch) { state.activating = false; publish(); } }
  }
  function dispatch(command = {}) {
    if (disposed) return;
    try {
      switch (command.action) {
        case 'open':
          state.open = true;
          if (command.pack) { if (!dependencies.has(command.pack)) throw new Error('当前版本未提供该资源包'); state.addons.add(command.pack); }
          startWatch(); publish(); return;
        case 'close': state.open = false; stopWatch(); publish(); return;
        case 'selectProfile':
          if (state.job || state.activating) return;
          resolveContentPlan(catalog, {profile: command.profile}); state.profile = command.profile;
          for (const id of state.addons) if (included(id)) state.addons.delete(id);
          state.message = ''; state.error = false; publish(); return;
        case 'selectPack':
          if (state.job || state.activating) return;
          if (!dependencies.has(command.id)) throw new Error('当前版本未提供该资源包');
          if (!included(command.id)) {
            if (command.checked === true) state.addons.add(command.id);
            else for (const id of state.addons) if (dependencies.get(id).includes(command.id)) state.addons.delete(id);
          }
          state.message = ''; state.error = false; publish(); return;
        case 'download': return download(command.id ?? 'selection').catch(report);
        case 'cancel': state.job?.controller.abort(); return;
        case 'activate': return activate().catch(report);
        default: throw new Error('资源管理操作无效');
      }
    } catch (error) { report(error); }
  }
  publish();
  return {dispatch, snapshot, refresh: publish, dispose() {
    if (disposed) return; disposed = true; ++epoch; stopWatch(); state.job?.controller.abort(); state.job = null;
  }};
}
