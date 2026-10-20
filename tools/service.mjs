import fs from 'node:fs/promises';
import path from 'node:path';
import {loadConfig, projectRoot, roles} from './services/config.mjs';

const args = process.argv.slice(2), role = args[0];
if (!roles.includes(role)) throw new Error('Usage: node tools/service.mjs web|resources|lobby|battle [--config file] [--dev]');
const configIndex = args.indexOf('--config');
if (configIndex >= 0 && !args[configIndex + 1]) throw new Error('--config requires a JSON file');
const config = await loadConfig(configIndex >= 0 ? args[configIndex + 1] : undefined);
const common = {...config[role], allowedOrigins: config.allowedOrigins};
const serviceSecret = process.env.WERHD_SERVICE_SECRET;
if (['lobby', 'battle'].includes(role) && (!serviceSecret || serviceSecret.length < 16)) {
  throw new Error('Set WERHD_SERVICE_SECRET to the same secret (at least 16 characters) for lobby and battle. start:stack generates one automatically.');
}
let app;
switch (role) {
  case 'resources': {
    const {createResourceServer} = await import('./services/resource-server.mjs');
    app = await createResourceServer({...common, root: projectRoot, assetRoot: config.assetRoot,
      publicDir: args.includes('--dev') ? config.publicDir : config.distDir});
    break;
  }
  case 'web': {
    const {createSiteServer} = await import('./services/site-server.mjs');
    app = await createSiteServer({...common, root: projectRoot, distDir: config.distDir,
      production: !args.includes('--dev'), runtimeConfig: config.runtime});
    break;
  }
  case 'battle': {
    const {createBattleService} = await import('./services/battle-server.mjs');
    app = await createBattleService({...common, serviceSecret});
    break;
  }
  case 'lobby': {
    const {createLobbyService} = await import('./services/lobby-server.mjs');
    const catalog = JSON.parse(await fs.readFile(path.join(args.includes('--dev') ? config.publicDir : config.distDir, 'generated/catalog.json'), 'utf8'));
    const mapLimits = new Map(catalog.maps.map(map => [map.id, Math.max(2, map.starts?.length ?? map.maxPlayers ?? 2)]));
    app = await createLobbyService({...common, serviceSecret, battleUrl: config.battle.internalUrl, mapLimits});
    break;
  }
}
const ready = {type: 'ready', role, pid: process.pid, url: app.url, publicUrl: config[role].publicUrl};
console.log(JSON.stringify(ready));
process.send?.(ready);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 5000); deadline.unref();
  await app.close();
  clearTimeout(deadline);
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
if (process.send) process.on('disconnect', close);
