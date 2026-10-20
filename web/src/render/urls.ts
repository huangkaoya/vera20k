import { resolveHttpUrl } from '../config/runtime';
import type { AssetsManifest } from './types';

/** Only this boundary converts retail export paths into browser resource addresses. */
export function resolveArtManifest(value: unknown, manifestUrl: string, pageUrl = manifestUrl): AssetsManifest {
  if (!value || typeof value !== 'object') throw new Error('地图美术清单无效');
  const manifest = value as AssetsManifest;
  if (manifest.schema !== 1 || !Array.isArray(manifest.maps) || !manifest.maps.length || !manifest.sprites || typeof manifest.sprites !== 'object') {
    throw new Error('地图美术版本无效，请运行资源编译脚本');
  }
  const assetUrl = (value: unknown) => resolveHttpUrl(value, manifestUrl, pageUrl, '地图美术 URL');
  return {
    ...manifest,
    maps: manifest.maps.map(map => ({ ...map, image: assetUrl(map.image), minimap: assetUrl(map.minimap) })),
    sprites: Object.fromEntries(Object.entries(manifest.sprites).map(([id, sprite]) => {
      // Rust serializes absent optional art as null; normalize it to an absent TS field.
      const { remapImage, cameo, ...required } = sprite;
      return [id, {
        ...required, image: assetUrl(sprite.image),
        ...(remapImage != null ? { remapImage: assetUrl(remapImage) } : {}),
        ...(cameo != null ? { cameo: assetUrl(cameo) } : {}),
      }];
    })),
  };
}
