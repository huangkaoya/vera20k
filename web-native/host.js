import {serviceOrigin, staticRelease as defaultStaticRelease} from './host-config.js';

function bundledRelease(config, moduleUrl) {
  if (config === null) return null;
  const record = value => value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  if (!record(config) || Object.keys(config).some(key => !['build', 'catalog', 'module', 'content'].includes(key))
    || !record(config.content) || !Object.keys(config.content).length)
    throw new Error('静态游戏版本配置无效');
  let directory;
  try { directory = new URL('.', moduleUrl); } catch { throw new Error('静态游戏文件地址无效'); }
  if (!['https:', 'http:'].includes(directory.protocol) || directory.username || directory.password)
    throw new Error('静态游戏文件地址无效');
  const local = value => {
    if (typeof value !== 'string') throw new Error('静态游戏文件路径无效');
    const relative = value.startsWith('./') ? value.slice(2) : value;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(relative)
      || relative.split('/').some(segment => !segment || segment === '.' || segment === '..'))
      throw new Error('静态游戏文件路径无效');
    const address = new URL(relative, directory);
    if (address.origin !== directory.origin || !address.pathname.startsWith(directory.pathname))
      throw new Error('静态游戏文件路径超出游戏目录');
    return address.href;
  };
  const content = new Map(Object.entries(config.content).map(([original, relative]) => {
    if (!/^\/content\/objects\/[a-f0-9]{64}$/.test(original)) throw new Error('静态游戏引擎对象地址无效');
    return [original, local(relative)];
  }));
  return {build: local(config.build), catalog: local(config.catalog), module: local(config.module), content};
}

export function createWebHost({origin = serviceOrigin, pageUrl = globalThis.location?.href,
  moduleUrl = import.meta.url, staticRelease = defaultStaticRelease,
  fetch = globalThis.fetch?.bind(globalThis)} = {}) {
  const base = new URL(origin || pageUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password)
    throw new Error('游戏服务地址无效');
  const serviceUrl = pathname => new URL(pathname, base.origin).href;
  const release = bundledRelease(staticRelease, moduleUrl);
  return Object.freeze({
    serviceUrl,
    buildUrl: () => release?.build ?? serviceUrl('/native/build.json'),
    catalogUrl: () => release?.catalog ?? serviceUrl('/api/native/resources'),
    engineModuleUrl(sha256) {
      // Toy releases use an immutable version directory. Keep its module URL
      // query-free because the platform may route/cache queried paths differently.
      if (release) return release.module;
      const address = new URL(serviceUrl('/native/werhd.js'));
      if (sha256 !== undefined) address.searchParams.set('sha256', sha256);
      return address.href;
    },
    assetUrl: relative => new URL(relative, moduleUrl).href,
    // Art objects are handled by the pinned Toy shards. Only the bundled engine
    // may reach this static fallback; an unknown object must never contact CF.
    async fetchContent(url, options = {}) {
      const target = release ? release.content.get(url) : serviceUrl(url);
      if (!target) throw new Error('当前静态游戏版本未包含请求的资源');
      return fetch(target, {...options, credentials: 'omit'});
    },
  });
}
