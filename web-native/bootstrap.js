const status = document.querySelector('#status');
const progress = document.querySelector('#progress');
const startup = document.querySelector('#startup');
const canvas = document.querySelector('#game');
try {
  if (!navigator.gpu) throw new Error('当前浏览器未提供 WebGPU。请使用支持 WebGPU 的浏览器打开游戏。');
  const native = await import('/native/vera20k.js');
  const {installNativeLobby} = await import('./lobby.js');
  status.textContent = '正在载入游戏引擎…';
  await native.default();
  const font = new FontFace('Vera UI', 'url(/fonts/FiraSansCondensed-Medium.ttf)', {weight:'500'});
  document.fonts.add(await font.load());
  const response = await fetch('/api/native/resources');
  if (!response.ok) throw new Error(`游戏资源清单读取失败：${response.status}`);
  const manifest = await response.json();
  let completed = 0;
  for (const file of manifest.files) {
    status.textContent = `正在载入游戏资源 ${Math.round(completed / 1048576)} / ${Math.round(manifest.totalBytes / 1048576)} MB`;
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`资源 ${file.name} 读取失败：${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== file.bytes) throw new Error(`资源 ${file.name} 长度校验失败`);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
    if (digest !== file.sha256) throw new Error(`资源 ${file.name} 完整性校验失败`);
    native.mount_resource(file.name, bytes);
    completed += file.bytes;
    progress.value = completed / manifest.totalBytes;
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  status.textContent = '正在初始化画面…';
  const initialized = new Promise((resolve, reject) => {
    const inspect = () => {
      if (canvas.dataset.veraStage === 'ready') { observer.disconnect(); resolve(); }
      else if (canvas.dataset.veraStage === 'error') { observer.disconnect(); reject(new Error(canvas.dataset.veraError ?? '原生客户端初始化失败')); }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(canvas, {attributes:true, attributeFilter:['data-vera-stage','data-vera-error']});
  });
  installNativeLobby({native,canvas});
  native.start_browser(canvas);
  Object.defineProperty(window, '__veraNative', {value:Object.freeze({sourceRevision:native.source_revision(), diagnostics:()=>native.browser_diagnostics?.(), networkStatus:()=>native.network_status()})});
  await initialized;
  startup.hidden = true;
  canvas.focus();
} catch (error) {
  status.textContent = `游戏启动失败：${error instanceof Error ? error.message : String(error)}`;
  progress.hidden = true;
  console.error(error);
}
