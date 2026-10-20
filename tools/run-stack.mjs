import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadConfig, projectRoot} from './services/config.mjs';

const args = process.argv.slice(2), configIndex = args.indexOf('--config');
if (configIndex >= 0 && !args[configIndex + 1]) throw new Error('--config requires a JSON file');
const configPath = configIndex >= 0 ? args[configIndex + 1] : 'config/sites.local.json';
const config = await loadConfig(configPath);
const secret = process.env.WERHD_SERVICE_SECRET ?? randomBytes(32).toString('hex');
const children = [], readyServices = [];
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5500); deadline.unref();
    child.once('exit', () => {clearTimeout(deadline); resolve();});
    child.kill('SIGTERM');
  })));
  process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
async function start(role) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./service.mjs', import.meta.url)), role,
    '--config', configPath, ...(args.includes('--dev') ? ['--dev'] : [])], {
    cwd: projectRoot, env: {...process.env, WERHD_SERVICE_SECRET: secret}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  for (const [stream, dest] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8');
    stream.on('data', data => dest.write(`[${role}] ${data}`));
  }
  const ready = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`${role} did not become ready in 60 seconds`)), 60000);
    child.once('error', error => {clearTimeout(deadline); reject(error);});
    child.once('exit', (code, signal) => {
      clearTimeout(deadline);
      if (!stopping) {reject(new Error(`${role} exited (${code ?? signal})`)); void stop(1);}
    });
    child.once('message', message => {clearTimeout(deadline); resolve(message);});
  });
  if (ready?.type !== 'ready' || ready.role !== role) throw new Error(`Invalid ${role} ready message`);
  const health = await fetch(new URL('/api/health', ready.url), {signal: AbortSignal.timeout(5000)});
  if (!health.ok) throw new Error(`${role} health check failed: ${health.status}`);
  readyServices.push(ready);
}
try {
  // Battle must accept registration before the lobby accepts room starts.
  await start('battle');
  await start('lobby');
  await start('resources');
  await start('web');
  console.log(JSON.stringify({type: 'stack-ready', url: config.web.publicUrl, runtime: config.runtime, services: readyServices}));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await stop(1);
}
