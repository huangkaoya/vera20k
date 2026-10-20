import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const sha = value => createHash('sha256').update(value).digest('hex');
function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (expected === 0) assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}
function git(cwd, ...args) {
  return run('git', ['-c', 'user.name=Sync Fixture', '-c', 'user.email=sync-fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], cwd).stdout.trim();
}
async function fixture(t) {
  await fs.mkdir('.build', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.build/sync-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'tools')); await fs.copyFile('tools/sync_upstream.py', path.join(root, 'tools/sync_upstream.py'));
  // A nested fixture repository ensures git apply never resolves the real
  // application's worktree. Every source, patch and output lives in .build.
  git(root, 'init', '--quiet');
  const upstream = path.join(root, 'source'), vendor = path.join(root, 'vendor/fixture');
  await fs.mkdir(path.join(upstream, 'src'), { recursive: true }); await fs.mkdir(vendor, { recursive: true });
  git(upstream, 'init', '--quiet');
  await fs.writeFile(path.join(upstream, 'src/keep.rs'), 'pub const VALUE: u32 = 1;\n');
  await fs.writeFile(path.join(upstream, 'src/old empty.txt'), '');
  git(upstream, 'add', 'src'); git(upstream, 'commit', '--quiet', '-m', 'initial fixture');
  const revision = git(upstream, 'rev-parse', 'HEAD'), files = {};
  for (const name of ['src/keep.rs', 'src/old empty.txt']) {
    const body = await fs.readFile(path.join(upstream, name)); files[name] = { source_path: name, sha256: sha(body) };
    await fs.mkdir(path.dirname(path.join(vendor, name)), { recursive: true }); await fs.writeFile(path.join(vendor, name), body);
  }
  await fs.writeFile(path.join(root, 'upstream.lock.json'), JSON.stringify({ schema: 1, sources: { fixture: { source: upstream, revision, paths: ['src'], files } } }));
  await fs.writeFile(path.join(vendor, 'src/keep.rs'), 'pub const VALUE: u32 = 2;\n');
  await fs.writeFile(path.join(vendor, 'src/new empty.txt'), ''); await fs.unlink(path.join(vendor, 'src/old empty.txt'));
  const cli = (...args) => run('python3', ['tools/sync_upstream.py', ...args], root);
  cli('patches'); cli('check');
  return { root, upstream, vendor, cli };
}

test('sync roundtrip preserves new/deleted empty files through pinned replay and actual replacement', async t => {
  const { root, upstream, vendor, cli } = await fixture(t);
  const patch = await fs.readFile(path.join(root, 'patches/fixture.patch'), 'utf8');
  assert.match(patch, /new file mode 100644/); assert.match(patch, /deleted file mode 100644/);
  cli('sync'); cli('check');
  assert.equal((await fs.stat(path.join(vendor, 'src/new empty.txt'))).size, 0);
  await assert.rejects(fs.stat(path.join(vendor, 'src/old empty.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(vendor, 'src/keep.rs'), 'utf8'), 'pub const VALUE: u32 = 2;\n');
  // An unrelated committed upstream addition requires stage -> replace,
  // rather than the identical-content fast path of a pinned replay.
  await fs.writeFile(path.join(upstream, 'src/next.rs'), 'pub const NEXT: bool = true;\n');
  git(upstream, 'add', 'src/next.rs'); git(upstream, 'commit', '--quiet', '-m', 'unrelated upstream addition');
  cli('sync', '--update'); cli('check');
  assert.equal(await fs.readFile(path.join(vendor, 'src/next.rs'), 'utf8'), 'pub const NEXT: bool = true;\n');
  assert.equal((await fs.stat(path.join(vendor, 'src/new empty.txt'))).size, 0);
  await assert.rejects(fs.stat(path.join(vendor, 'src/old empty.txt')), { code: 'ENOENT' });
  const before = await fs.stat(path.join(vendor, 'src/new empty.txt'), { bigint: true });
  cli('sync'); cli('check');
  const after = await fs.stat(path.join(vendor, 'src/new empty.txt'), { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs, 'identical pinned replay preserves source mtimes');
  assert.equal(await fs.readFile(path.join(upstream, 'src/keep.rs'), 'utf8'), 'pub const VALUE: u32 = 1;\n', 'original source file stays unchanged');
  assert.equal(git(upstream, 'status', '--porcelain'), '', 'upstream fixture stays clean');
});

test('pinned staged hash verification rejects a missing empty-file overlay before replacing vendor', async t => {
  const { root, vendor } = await fixture(t);
  const patchPath = path.join(root, 'patches/fixture.patch');
  const patch = await fs.readFile(patchPath, 'utf8');
  const changed = patch.replace(/diff --git "a\/src\/new empty\.txt" "b\/src\/new empty\.txt"\nnew file mode 100644\nindex 0000000\.\.e69de29\n/, '');
  assert.notEqual(changed, patch, 'fixture removes exactly the empty addition from the replay');
  await fs.writeFile(patchPath, changed);
  const lockPath = path.join(root, 'patches.lock.json'), lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  lock.sources.fixture.sha256 = sha(changed); await fs.writeFile(lockPath, JSON.stringify(lock));
  const before = await fs.stat(path.join(vendor, 'src/keep.rs'), { bigint: true });
  // Current vendor still matches recorded overlay hashes, but the patch no
  // longer reconstructs them. This must stop while everything is staged.
  run('python3', ['tools/sync_upstream.py', 'check'], root);
  const result = run('python3', ['tools/sync_upstream.py', 'sync'], root, 1);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /staged snapshot does not match/);
  assert.equal((await fs.stat(path.join(vendor, 'src/new empty.txt'))).size, 0);
  await assert.rejects(fs.stat(path.join(vendor, 'src/old empty.txt')), { code: 'ENOENT' });
  assert.equal((await fs.stat(path.join(vendor, 'src/keep.rs'), { bigint: true })).mtimeNs, before.mtimeNs);
});
