// Fatal state belongs to the native runtime. Ordinary console/network errors
// do not stop a game; only its explicit canvas error state reaches this owner.
export function watchRuntimeFailure({canvas, onFailure, MutationObserver: Observer = globalThis.MutationObserver} = {}) {
  if (!canvas?.dataset || typeof onFailure !== 'function' || typeof Observer !== 'function')
    throw new Error('缺少游戏错误监测入口');
  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false; observer.disconnect();
  };
  const inspect = () => {
    if (!active || canvas.dataset.werhdStage !== 'error') return;
    const failure = Object.freeze({message: canvas.dataset.werhdError || '游戏运行失败',
      stage: canvas.dataset.werhdLoadStage || null});
    dispose();
    onFailure(failure);
  };
  const observer = new Observer(inspect);
  observer.observe(canvas, {attributes: true,
    attributeFilter: ['data-werhd-stage', 'data-werhd-error', 'data-werhd-load-stage']});
  // A fatal may have happened between startup readiness and this installation.
  inspect();
  return Object.freeze({dispose});
}
