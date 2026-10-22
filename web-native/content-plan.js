// Engine/lobby independent planning. A profile is a complete mounting view;
// optional packages may append files, but never override a gameplay winner.
const capabilityNames = ['campaign', 'movies', 'music', 'menuAnimation'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function resolveContentPlan(catalog, {profile = 'skirmish', addons = []} = {}) {
  if (catalog?.schema !== 2 || !sha(catalog.identity) || !sha(catalog.catalogIdentity)) throw new Error('资源目录版本无效');
  const selected = catalog.profiles?.[profile];
  if (!selected || !['skirmish', 'full'].includes(profile) || !Array.isArray(selected.files) || selected.requiredResourceIdentity !== catalog.identity)
    throw new Error('资源配置与遭遇战版本不一致');
  if (!Array.isArray(addons) || addons.length > 16) throw new Error('可选资源配置无效');
  const installed = [], visiting = new Set(), visited = new Set();
  const visit = id => {
    if (visited.has(id)) return;
    const pack = catalog.packs?.[id];
    if (typeof id !== 'string' || !pack || !Array.isArray(pack.files) || visiting.has(id)) throw new Error('资源包依赖无效');
    visiting.add(id);
    for (const dependency of pack.dependsOn ?? []) visit(dependency);
    visiting.delete(id); visited.add(id); installed.push(id);
  };
  addons.forEach(visit);
  const capabilities = Object.fromEntries(capabilityNames.map(name => [name, selected.capabilities?.[name] === true]));
  const byName = new Map();
  const add = file => {
    if (typeof file?.name !== 'string' || !file.name || /[/\\\0]/.test(file.name) || !sha(file.sha256) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('资源文件描述无效');
    const name = file.name.toLowerCase(), previous = byName.get(name);
    if (previous && (previous.sha256 !== file.sha256 || previous.bytes !== file.bytes))
      throw new Error(`资源 ${file.name} 与当前配置冲突，请选择完整内容配置`);
    if (!previous) byName.set(name, file);
  };
  selected.files.forEach(add);
  for (const id of installed) {
    const pack = catalog.packs[id]; pack.files.forEach(add);
    for (const name of capabilityNames) if (pack.capabilities?.[name] === true) capabilities[name] = true;
  }
  if (capabilities.campaign && !capabilities.movies) throw new Error('战役资源需要对应过场动画包');
  const files = [...byName.values()];
  return Object.freeze({profile, addons: Object.freeze(installed), files: Object.freeze(files),
    capabilities: Object.freeze(capabilities), requiredResourceIdentity: catalog.identity,
    catalogIdentity: catalog.catalogIdentity, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    downloadBytes: files.reduce((sum, file) => sum + (file.download?.bytes ?? file.bytes), 0)});
}
