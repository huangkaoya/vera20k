import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {projectRoot} from '../tools/services/config.mjs';

async function allocatePorts(count) {
  const sockets = [], ports = [];
  try {
    for (let i = 0; i < count; i++) {
      const socket = net.createServer(); sockets.push(socket);
      await new Promise((resolve, reject) => {socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve);});
      ports.push(socket.address().port);
    }
    return ports;
  } finally { await Promise.all(sockets.map(socket => new Promise(resolve => socket.close(resolve)))); }
}
test('production stack launches four separate healthy processes and stops only its children', {timeout: 30000}, async t => {
  await fs.mkdir(path.join(projectRoot, '.build'), {recursive: true});
  const fixture = await fs.mkdtemp(path.join(projectRoot, '.build/stack-test-'));
  const publicDir = path.join(fixture, 'site'), retail = path.join(fixture, 'retail');
  await fs.mkdir(path.join(publicDir, 'generated'), {recursive: true}); await fs.mkdir(retail);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>stack fixture</title>');
  await fs.writeFile(path.join(publicDir, 'generated/catalog.json'), JSON.stringify({schema: 1, maps: [{id: 'fixture.map', maxPlayers: 2}]}));
  await fs.writeFile(path.join(retail, 'ra2.mix'), 'fixture retail');
  const ports = await allocatePorts(4), config = {schema: 1};
  ['web','resources','lobby','battle'].forEach((role, index) => config[role] = {host: '127.0.0.1', port: ports[index], publicUrl: `http://127.0.0.1:${ports[index]}`});
  config.web.distDir = publicDir; config.resources.publicDir = path.join(fixture, 'public-not-shipped'); config.resources.assetRoot = retail;
  config.battle.internalUrl = config.battle.publicUrl;
  const filename = path.join(fixture, 'config.json'); await fs.writeFile(filename, JSON.stringify(config));
  const env = {...process.env}; delete env.VERA_ASSET_ROOT; delete env.WERHD_SERVICE_SECRET;
  const runner = spawn(process.execPath, ['tools/run-stack.mjs','--config',filename], {cwd: projectRoot, env, stdio: ['ignore','pipe','pipe']});
  let output = '', exited = false;
  const exit = new Promise(resolve => runner.once('exit', (code, signal) => {exited = true; resolve({code, signal});}));
  t.after(async () => {if (!exited) {runner.kill('SIGTERM'); await exit;} await fs.rm(fixture, {recursive: true, force: true});});
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Stack startup timeout: ${output}`)), 20000);
    runner.on('error', error => {clearTimeout(timeout); reject(error);});
    runner.once('exit', code => {clearTimeout(timeout); reject(new Error(`Stack exited ${code}: ${output}`));});
    runner.stderr.on('data', bytes => {output += bytes.toString();});
    let lines = '';
    runner.stdout.on('data', bytes => {
      const text = bytes.toString(); output += text; lines += text;
      let index;
      while ((index = lines.indexOf('\n')) >= 0) {
        const line = lines.slice(0,index); lines = lines.slice(index+1);
        if (!line.startsWith('{')) continue;
        try {const value = JSON.parse(line); if (value.type === 'stack-ready') {clearTimeout(timeout); resolve(value);}} catch {}
      }
    });
  });
  assert.equal(ready.services.length, 4);
  assert.equal(new Set(ready.services.map(service => service.pid)).size, 4);
  assert.ok(ready.services.every(service => service.pid !== runner.pid));
  const requests = await Promise.all(ready.services.map(async service => {
    const response = await fetch(`${service.url}/api/health`); assert.equal(response.status, 200); return response.json();
  }));
  assert.ok(requests.every(result => result.ok));
  const runtime = await (await fetch(`${config.web.publicUrl}/api/config`)).json();
  assert.equal(runtime.assets.manifestUrl, `${config.resources.publicUrl}/generated/catalog.json`);
  assert.equal(runtime.network.lobbyUrl, `${config.lobby.publicUrl.replace('http:', 'ws:')}/ws/rooms`);
  assert.equal((await fetch(`${config.web.publicUrl}/api/resources`)).status, 404);
  assert.equal((await fetch(`${config.resources.publicUrl}/`)).status, 404);
  const resourceResponse = await fetch(runtime.assets.resourceManifestUrl, {headers: {Origin: config.web.publicUrl}});
  assert.equal(resourceResponse.headers.get('access-control-allow-origin'), config.web.publicUrl);
  const resources = await resourceResponse.json();
  assert.equal(resources.files.length, 1);
  assert.equal(new URL(resources.files[0].url, runtime.assets.resourceManifestUrl).origin, config.resources.publicUrl);
  assert.doesNotMatch(JSON.stringify(runtime), /secret|assetRoot|internalUrl/);
  runner.kill('SIGTERM'); assert.equal((await exit).code, 0);
  await Promise.all(ready.services.map(async service => {
    await assert.rejects(fetch(`${service.url}/api/health`, {signal: AbortSignal.timeout(1000)}));
  }));
});

test('an occupied later service port stops this stack without closing the existing listener', {timeout: 30000}, async t => {
  await fs.mkdir(path.join(projectRoot, '.build'), {recursive: true});
  const fixture = await fs.mkdtemp(path.join(projectRoot, '.build/stack-conflict-test-'));
  const publicDir = path.join(fixture, 'site'), retail = path.join(fixture, 'retail');
  await fs.mkdir(path.join(publicDir, 'generated'), {recursive: true}); await fs.mkdir(retail);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>conflict fixture</title>');
  await fs.writeFile(path.join(publicDir, 'generated/catalog.json'), JSON.stringify({schema: 1, maps: [{id: 'fixture.map', maxPlayers: 2}]}));
  await fs.writeFile(path.join(retail, 'ra2.mix'), 'fixture retail');
  const blocker = http.createServer((_request, response) => response.end('pre-existing listener'));
  await new Promise((resolve, reject) => {blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve);});
  const ports = await allocatePorts(3), config = {schema: 1};
  config.web = {host: '127.0.0.1', port: ports[0], publicUrl: `http://127.0.0.1:${ports[0]}`};
  config.resources = {host: '127.0.0.1', port: blocker.address().port, publicUrl: `http://127.0.0.1:${blocker.address().port}`};
  config.lobby = {host: '127.0.0.1', port: ports[1], publicUrl: `http://127.0.0.1:${ports[1]}`};
  config.battle = {host: '127.0.0.1', port: ports[2], publicUrl: `http://127.0.0.1:${ports[2]}`};
  config.web.distDir = publicDir; config.resources.publicDir = publicDir; config.resources.assetRoot = retail;
  config.battle.internalUrl = config.battle.publicUrl;
  const filename = path.join(fixture, 'config.json'); await fs.writeFile(filename, JSON.stringify(config));
  const secret = 'stack-conflict-private-secret-fixture', env = {...process.env, WERHD_SERVICE_SECRET: secret};
  delete env.VERA_ASSET_ROOT;
  const runner = spawn(process.execPath, ['tools/run-stack.mjs','--config',filename], {cwd: projectRoot, env, stdio: ['ignore','pipe','pipe']});
  let output = '', exited = false;
  const exit = new Promise((resolve, reject) => {
    runner.once('error', reject);
    runner.once('exit', (code, signal) => {exited = true; resolve({code, signal});});
  });
  for (const stream of [runner.stdout, runner.stderr]) stream.on('data', bytes => {output += bytes.toString();});
  t.after(async () => {
    if (!exited) {runner.kill('SIGKILL'); await exit;}
    await new Promise(resolve => {blocker.close(resolve); blocker.closeAllConnections();});
    await fs.rm(fixture, {recursive: true, force: true});
  });
  let deadline;
  const result = await Promise.race([exit, new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error(`Conflict did not stop stack: ${output}`)), 20000);
  })]).finally(() => clearTimeout(deadline));
  assert.equal(result.code, 1, output);
  assert.match(output, /EADDRINUSE/);
  assert.doesNotMatch(output, /"type":"stack-ready"/);
  assert.ok(!output.includes(secret), 'startup failure must not print the shared service secret');
  const started = output.split('\n').flatMap(line => {
    const match = /^\[(battle|lobby)\]\s+(\{.*\})$/.exec(line);
    if (!match) return [];
    const ready = JSON.parse(match[2]); return ready.type === 'ready' ? [ready] : [];
  });
  assert.deepEqual(new Set(started.map(service => service.role)), new Set(['battle','lobby']), output);
  for (const service of started) {
    assert.throws(() => process.kill(service.pid, 0), {code: 'ESRCH'}, `${service.role} child must exit`);
    await assert.rejects(fetch(`${service.url}/api/health`, {signal: AbortSignal.timeout(1000)}));
  }
  const response = await fetch(config.resources.publicUrl);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'pre-existing listener');
  assert.ok(blocker.listening, 'the pre-existing server remains owned by this test');
});
