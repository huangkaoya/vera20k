const PACKS = {
  campaign: ['战役资源', '原版战役地图与相关内容，包含对应的过场影片。'],
  cinematics: ['过场影片', '原版剧情与过场影片。'],
  music: ['原版音乐', '完整的原版背景音乐。'],
  brandingAnimation: ['菜单动画', '王二火大品牌菜单动画。'],
};
let panelCount = 0;
function element(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
}
function button(text, action, {primary = false, disabled = false} = {}) {
  const node = element('button', `vc-button${primary ? ' vc-primary' : ''}`, text);
  node.type = 'button'; node.disabled = disabled; node.addEventListener('click', action); return node;
}
function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
const fileKey = file => file.sha256.toLowerCase();
function uniqueFiles(groups) {
  const names = new Map(), hashes = new Map();
  for (const files of groups) for (const file of files) {
    const name = file.name.toLowerCase(), existing = names.get(name);
    if (existing && fileKey(existing) !== fileKey(file)) throw new Error(`资源“${file.name}”存在两个版本，请改用完整内容，或取消冲突的可选包。`);
    names.set(name, file); hashes.set(fileKey(file), file);
  }
  return [...hashes.values()];
}
const wireSize = files => files.reduce((total, file) => total + (file.download?.bytes ?? file.bytes), 0);
const rawSize = files => files.reduce((total, file) => total + file.bytes, 0);

/** A replaceable content UI. Activation belongs to the caller and always
 * requires a reload; this module never imports or mounts a game engine. */
export function installContentPanel({catalog, store, onActivate, isActivationAllowed = () => true, initialSelection = {profile:'skirmish',addons:[]}} = {}) {
  if (catalog?.schema !== 2 || !catalog.profiles?.skirmish || !catalog.profiles?.full || !store?.prefetch || typeof onActivate !== 'function') throw new Error('资源管理缺少有效的内容目录或下载入口');
  const packs = catalog.packs ?? {}, profileName = `vera-content-profile-${++panelCount}`;
  resolveContentPlan(catalog); resolveContentPlan(catalog, {profile: 'full'});
  const dependencyPlans = new Map(Object.keys(packs).map(id => [id, resolveContentPlan(catalog, {addons: [id]})]));
  const dependencies = id => dependencyPlans.get(id)?.addons ?? [];
  const stylesheet = element('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./content-panel.css', import.meta.url).href;
  document.head.append(stylesheet);
  const launcher = button('资源管理', () => open()); launcher.classList.add('vc-launcher');
  launcher.setAttribute('aria-haspopup', 'dialog'); launcher.setAttribute('aria-expanded', 'false');
  const shell = element('section', 'vera-content-panel'); shell.hidden = true;
  shell.setAttribute('role', 'dialog'); shell.setAttribute('aria-modal', 'true'); shell.setAttribute('aria-label', '资源管理');
  document.body.append(launcher, shell);
  const initialPlan = resolveContentPlan(catalog, initialSelection);
  const state = {profile: initialPlan.profile, addons: new Set(initialPlan.addons), job: null, verified: new Set(), cacheStatuses: new Map(), message: '', error: false, activating: false};
  let disposed = false, epoch = 0, previousFocus, progressView, allowedTimer = null, allowedEpoch = 0, lastAllowed;

  function allowed() { try { return isActivationAllowed() === true; } catch { return false; } }
  function stopAllowedWatch() { ++allowedEpoch; if (allowedTimer !== null) clearInterval(allowedTimer); allowedTimer = null; }
  function watchAllowed() {
    if (allowedTimer !== null) return;
    const token = ++allowedEpoch; lastAllowed = allowed();
    allowedTimer = setInterval(() => {
      if (disposed || shell.hidden || token !== allowedEpoch) return;
      const next = allowed();
      if (next !== lastAllowed) { lastAllowed = next; render(); }
    }, 250);
  }
  function packFiles(id) { return uniqueFiles(dependencies(id).map(key => packs[key].files)); }
  function included(id) {
    const files = packFiles(id), profileFiles = new Map(catalog.profiles[state.profile].files.map(file => [file.name.toLowerCase(), fileKey(file)]));
    return files.length > 0 && files.every(file => profileFiles.get(file.name.toLowerCase()) === fileKey(file));
  }
  function addons() {
    const result = new Set();
    for (const id of state.addons) if (!included(id)) for (const key of dependencies(id)) if (!included(key)) result.add(key);
    return [...result];
  }
  function selection() {
    return resolveContentPlan(catalog, {profile: state.profile, addons: addons()});
  }
  function cached(file) { return store.cacheStatus?.(file) ?? state.cacheStatuses.get(fileKey(file)) ?? 'unknown'; }
  function cacheSummary(files) {
    if (!files.length) return ['未提供', 'empty'];
    const statuses = files.map(cached);
    if (statuses.every(status => status === 'hit' || status === 'stored')) return ['已校验缓存', 'installed'];
    if (statuses.some(status => status === 'unavailable' || status === 'write-failed')) return ['缓存不可用 · 未安装', 'volatile'];
    if (statuses.some(status => status === 'hit' || status === 'stored')) return ['部分已缓存', 'partial'];
    return ['尚未检查缓存', 'unknown'];
  }
  function verified(files) { return files.length > 0 && files.every(file => state.verified.has(fileKey(file)) || ['hit', 'stored'].includes(cached(file))); }
  function close() {
    if (disposed) return;
    shell.hidden = true; stopAllowedWatch(); launcher.setAttribute('aria-expanded', 'false'); previousFocus?.focus?.();
  }
  function selectPack(id, checked) {
    if (checked) { if (!included(id)) state.addons.add(id); }
    else { for (const selected of [...state.addons]) if (dependencies(selected).includes(id)) state.addons.delete(selected); }
    state.message = ''; state.error = false; render();
    focusOption(id);
  }
  function focusOption(id) { [...shell.querySelectorAll('[data-content-id]')].find(node => node.dataset.contentId === id)?.querySelector('input')?.focus(); }
  function report(message, error = false) { state.message = message; state.error = error; render(); }
  async function download(title, files) {
    if (disposed || state.job || state.activating || !files.length) return;
    const token = ++epoch, controller = new AbortController();
    state.job = {title, controller, progress: null}; state.message = ''; state.error = false; render();
    try {
      const result = await store.prefetch(files, {signal: controller.signal, concurrency: 2, onProgress: progress => {
        if (disposed || token !== epoch || controller.signal.aborted) return;
        state.job.progress = progress; updateProgress();
      }});
      if (disposed || token !== epoch || controller.signal.aborted) return;
      for (const file of files) state.verified.add(fileKey(file));
      const byName = new Map(files.map(file => [file.name.toLowerCase(), file]));
      for (const entry of result.files ?? []) { const file = byName.get(entry.name.toLowerCase()); if (file) state.cacheStatuses.set(fileKey(file), entry.cacheStatus); }
      state.message = result.installed
        ? `${title}已下载并校验缓存。启用需要重新载入游戏。`
        : `${title}已下载并校验，但浏览器缓存不可用，资源未安装。重新载入时将再次下载。`;
    } catch (error) {
      if (disposed || token !== epoch) return;
      state.error = !controller.signal.aborted;
      state.message = controller.signal.aborted ? '下载已取消。已完成校验的缓存会保留，可重新下载继续。' : `下载失败：${error instanceof Error ? error.message : String(error)}。可重试。`;
    } finally {
      if (!disposed && token === epoch) { state.job = null; render(); }
    }
  }
  function downloadSelected() {
    try { const current = selection(); void download('所选内容', current.files); }
    catch (error) { report(error.message, true); }
  }
  async function activate() {
    if (disposed || state.job || state.activating) return;
    if (!allowed()) { report('请先退出当前对局或加载流程，再切换资源并重新载入。', true); return; }
    let current;
    try { current = selection(); } catch (error) { report(error.message, true); return; }
    if (!verified(current.files)) { report('请先下载并校验所选内容，再启用并重新载入。', true); return; }
    const token = ++epoch; state.activating = true; state.message = '正在切换资源，请等待重新载入…'; state.error = false; render();
    try {
      // Recheck at the final boundary; a download may have run during a match.
      if (!allowed()) throw new Error('当前正在对局或加载，请退出后再切换资源');
      await onActivate({profile: current.profile, addons: current.addons});
      if (disposed || token !== epoch) return;
      state.message = '启用请求已提交，需要重新载入游戏。';
    } catch (error) {
      if (disposed || token !== epoch) return;
      state.message = `无法启用：${error instanceof Error ? error.message : String(error)}`; state.error = true;
    } finally { if (!disposed && token === epoch) { state.activating = false; render(); } }
  }
  function optionCard({title, description, files, input, onDownload, note, id}) {
    const card = element('article', 'vc-card'); card.dataset.contentId = id;
    const heading = element('div', 'vc-card-heading'), label = element('label', 'vc-option');
    if (input) label.append(input); label.append(element('strong', '', title)); heading.append(label);
    const [status, kind] = cacheSummary(files); heading.append(element('span', `vc-cache vc-cache-${kind}`, status));
    card.append(heading, element('p', 'vc-description', description));
    const footer = element('div', 'vc-card-footer'), sizes = element('div', 'vc-size');
    sizes.append(element('strong', '', `下载 ${size(wireSize(files))}`), element('span', '', `原始内容 ${size(rawSize(files))}`)); footer.append(sizes);
    footer.append(button(kind === 'installed' ? '检查缓存' : '下载资源', onDownload, {disabled: !!state.job || state.activating || !files.length}));
    card.append(footer); if (note) card.append(element('p', 'vc-note', note)); return card;
  }
  function render() {
    if (disposed) return;
    const canActivate = allowed(); lastAllowed = canActivate;
    const frame = element('div', 'vc-frame'), header = element('header', 'vc-header');
    const title = element('div'); title.append(element('h2', '', '资源管理'), element('p', '', '默认遭遇战 · 可选完整内容'));
    const closeButton = button('关闭', close); header.append(title, closeButton); frame.append(header);
    const body = element('div', 'vc-body'), profiles = element('div', 'vc-profiles');
    body.append(element('p', 'vc-intro', '遭遇战包含对战所需的美术与音效，不含战役。可选内容按需下载，启用时会重新载入。'));
    for (const id of ['skirmish', 'full']) {
      const profile = catalog.profiles[id], input = element('input'); input.type = 'radio'; input.name = profileName; input.value = id;
      input.checked = state.profile === id; input.disabled = !!state.job || state.activating;
      input.addEventListener('change', () => { if (!input.checked) return; state.profile = id; for (const pack of [...state.addons]) if (included(pack)) state.addons.delete(pack); state.message = ''; state.error = false; render(); focusOption(`profile:${id}`); });
      profiles.append(optionCard({id: `profile:${id}`, input, title: id === 'skirmish' ? '默认遭遇战' : '完整内容',
        description: id === 'skirmish' ? '对战所需内容，优先进入菜单与遭遇战。' : '完整原版资源，包含战役、过场影片、音乐与菜单动画。',
        files: uniqueFiles([profile.files]), onDownload: () => void download(id === 'skirmish' ? '默认遭遇战' : '完整内容', uniqueFiles([profile.files]))}));
    }
    body.append(profiles, element('h3', '', '可选内容'));
    const optional = element('div', 'vc-packs');
    const selectedAddons = new Set(addons());
    for (const [id, pack] of Object.entries(packs)) {
      const [title, description] = PACKS[id] ?? [pack.title ?? id, '可选资源包。'];
      const input = element('input'); input.type = 'checkbox'; input.value = id;
      const contained = included(id); input.checked = contained || selectedAddons.has(id); input.disabled = contained || !!state.job || state.activating;
      input.addEventListener('change', () => selectPack(id, input.checked));
      const required = dependencies(id).filter(key => key !== id), files = packFiles(id);
      const note = contained ? '当前方案已包含。' : required.length ? `需同时下载：${required.map(key => PACKS[key]?.[0] ?? key).join('、')}；上方体积已包含依赖。` : '';
      optional.append(optionCard({id, input, title, description, files, note, onDownload: () => void download(title, files)}));
    }
    body.append(optional);
    const job = element('div', 'vc-job'); job.hidden = !state.job; job.setAttribute('aria-live', 'polite');
    const jobTitle = element('strong'), fileName = element('p', 'vc-job-file'), bar = element('progress'); bar.max = 1; bar.value = 0;
    const detail = element('p', 'vc-job-detail'), cancel = button('取消下载', () => { state.job?.controller.abort(); });
    job.append(jobTitle, fileName, bar, detail, cancel); body.append(job); progressView = {jobTitle, fileName, bar, detail};
    let current, conflict;
    try { current = selection(); } catch (error) { conflict = error.message; }
    const summary = element('div', 'vc-summary');
    if (current) summary.append(element('strong', '', `所选内容：下载 ${size(wireSize(current.files))} / 原始 ${size(rawSize(current.files))}`));
    else summary.append(element('strong', 'vc-error', conflict));
    summary.append(element('p', '', '缓存命中会跳过下载；显示的体积为完整资源大小。'));
    if (!canActivate) summary.append(element('p', 'vc-note', '对局或加载期间可以下载，退出后才能切换资源。'));
    const actions = element('div', 'vc-actions');
    actions.append(button('下载并校验所选内容', downloadSelected, {disabled: !!state.job || state.activating || !current}),
      button('启用并重新载入', () => void activate(), {primary: true, disabled: !!state.job || state.activating || !current || !verified(current.files) || !canActivate}));
    summary.append(actions); body.append(summary);
    if (state.message) { const message = element('p', `vc-message${state.error ? ' vc-error' : ''}`, state.message); message.setAttribute('role', state.error ? 'alert' : 'status'); body.append(message); }
    frame.append(body, element('footer', 'vc-footer', '已下载内容会在重新载入后启用。'));
    shell.replaceChildren(frame); launcher.textContent = state.job ? '资源管理 · 下载中' : '资源管理'; updateProgress();
  }
  function updateProgress() {
    const job = state.job; if (!job || !progressView || disposed) return;
    const progress = job.progress, done = progress?.completedFiles ?? 0, count = progress?.totalFiles ?? 0;
    progressView.jobTitle.textContent = `正在下载并校验：${job.title}`;
    progressView.fileName.textContent = progress?.file?.name ? `当前文件：${progress.file.name}` : '正在检查缓存…';
    const fraction = progress?.stage !== 'complete' && progress?.wireTotalBytes ? Math.min(.98, (progress.wireBytes ?? 0) / progress.wireTotalBytes) : 0;
    progressView.bar.value = count ? Math.min(1, (done + fraction) / count) : 0;
    const transferred = progress?.transferredWireBytes ?? 0, total = progress?.totalWireBytes ?? 0;
    progressView.detail.textContent = `已完成 ${done} / ${count} 个文件 · 当前文件 ${size(progress?.wireBytes ?? 0)} / ${size(progress?.wireTotalBytes ?? 0)} · 总传输 ${size(transferred)}${total ? ` / 清单 ${size(total)}` : ''}${progress?.stage === 'verify' ? ' · 正在校验' : ''}`;
  }
  function open({pack} = {}) {
    if (disposed) return;
    if (shell.hidden) previousFocus = document.activeElement;
    if (pack && packs[pack]) selectPack(pack, true);
    else if (pack) { state.message = '当前版本未提供该资源包。'; state.error = true; }
    shell.hidden = false; launcher.setAttribute('aria-expanded', 'true'); watchAllowed(); render();
    const target = pack ? [...shell.querySelectorAll('[data-content-id]')].find(node => node.dataset.contentId === pack) : null;
    target?.scrollIntoView?.({block: 'nearest'}); (target?.querySelector('button') ?? shell.querySelector('button'))?.focus();
  }
  const stopBubble = event => event.stopPropagation();
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'click', 'wheel', 'keyup']) shell.addEventListener(type, stopBubble);
  shell.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const controls = [...shell.querySelectorAll('button,input')].filter(node => !node.disabled && !node.hidden);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  return {open, dispose() { if (disposed) return; disposed = true; ++epoch; stopAllowedWatch(); state.job?.controller.abort(); state.job = null; shell.remove(); launcher.remove(); stylesheet.remove(); }};
}
import {resolveContentPlan} from './content-plan.js';

