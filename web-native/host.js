import {serviceOrigin} from './host-config.js';

export function createWebHost({origin = serviceOrigin, pageUrl = globalThis.location?.href,
  moduleUrl = import.meta.url, fetch = globalThis.fetch?.bind(globalThis)} = {}) {
  const base = new URL(origin || pageUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password)
    throw new Error('游戏服务地址无效');
  const serviceUrl = pathname => new URL(pathname, base.origin).href;
  return Object.freeze({
    serviceUrl,
    assetUrl: relative => new URL(relative, moduleUrl).href,
    // Use the original catalog URLs after its identity has been checked. Only
    // the transport origin changes, so network/resource identities are preserved.
    fetchContent: (url, options = {}) => fetch(serviceUrl(url), {...options, credentials: 'omit'}),
  });
}
