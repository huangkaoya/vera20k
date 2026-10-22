import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {publishResourceShards, classifyToyCliError} from '../tools/publish-native-resource-shards.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const catalogIdentity = 'b'.repeat(64), requiredResourceIdentity = 'c'.repeat(64);
const title = ordinal => `尤里版资源校验工具 ${String(ordinal).padStart(2, '0')}`;
const slug = ordinal => `werhd-yuri-res-bbbbbbbb-${String(ordinal).padStart(2, '0')}`;

// Real small PNG fixtures avoid depending on an image package or an external
// executable. Their pixel content can change while dimensions remain fixed.
function png(width, height, shade = 0) {
  function chunk(type, data) {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? crc >>> 1 ^ 0xedb88320 : crc >>> 1;
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const stride = width * 4 + 1, pixels = Buffer.alloc(stride * height, shade);
  for (let row = 0; row < height; row++) pixels[row * stride] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t, count = 2) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'werhd-resource-publishing-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const media = path.join(directory, 'media'); await fs.mkdir(media);
  const poster = path.join(media, 'poster.png'), icon = path.join(media, 'icon.png');
  await fs.writeFile(poster, png(120, 90)); await fs.writeFile(icon, png(32, 32));
  const packs = [];
  for (let index = 0; index < count; index++) {
    const packId = `pack-${String(index + 1).padStart(3, '0')}`;
    const packDirectory = path.join(directory, packId), archive = path.join(directory, packId + '.zip');
    await fs.mkdir(path.join(packDirectory, 'v2'), {recursive: true});
    const manifest = Buffer.from(JSON.stringify({packId, parts: []}));
    // The builder owns ZIP format/decompression tests. This publisher treats
    // its input as immutable bytes and must enforce their checked identity.
    const bytes = Buffer.from(`immutable archive fixture ${index}`);
    await fs.writeFile(archive, bytes); await fs.writeFile(path.join(packDirectory, 'v2/manifest.json'), manifest);
    packs.push({packId, directory: packDirectory, zip: archive, zipBytes: bytes.length,
      zipSha256: sha(bytes), manifestSha256: sha(manifest), partBytes: 0, parts: []});
  }
  const plan = {schema: 1, kind: 'werhd-toy-resource-upload-plan', enabled: false,
    catalogIdentity, requiredResourceIdentity, packs,
    stagedSources: packs.map(pack => ({packId: pack.packId, enabled: false, baseUrl: null,
      manifestPath: 'v2/manifest.json'}))};
  const planPath = path.join(directory, 'plan.json'), proofPath = path.join(directory, 'proof.json');
  async function writePlan() {
    const bytes = Buffer.from(JSON.stringify(plan));
    await fs.writeFile(planPath, bytes);
    await fs.writeFile(proofPath, JSON.stringify({ok: true, catalogIdentity, objects: 35, planSha256: sha(bytes)}));
  }
  await writePlan();
  return {directory, plan, planPath, proofPath, poster, icon, writePlan,
    journal: () => fs.readFile(path.join(directory, 'publication.json'), 'utf8').then(JSON.parse),
    options: {planPath, proofPath, poster, icon, onProgress() {}}};
}

function mockCli() {
  const calls = [], remote = [];
  const state = {creates: 0, behavior: 'success', missingMediaFlag: false};
  const run = async (cli, args) => {
    calls.push([...args]);
    if (args[0] === 'mylist') {
      assert.ok(args.includes('--json'));
      const page = Number(args[args.indexOf('--page') + 1]);
      const size = Number(args[args.indexOf('--size') + 1]);
      return {total: remote.length, list: remote.slice((page - 1) * size, page * size)};
    }
    if (args[0] === 'create' && args[1] === '--help-json')
      return {commands: [{path: ['create'], flags: [
        {name: 'category', choices: ['GAME', 'TOOL']},
        {name: 'visibility', choices: ['public', 'link-only']},
        {name: 'yes'}, {name: 'poster'}, ...(!state.missingMediaFlag ? [{name: 'icon'}] : []),
      ]}]};
    assert.equal(args[0], 'create', 'publisher must never invoke login, update, logout or another mutation');
    ++state.creates;
    const arg = key => args[args.indexOf(key) + 1];
    assert.equal(arg('--category'), 'TOOL'); assert.equal(arg('--visibility'), 'link-only');
    assert.equal(arg('--theme'), 'dark'); assert.ok(args.includes('--json')); assert.ok(args.includes('--yes'));
    assert.ok(path.isAbsolute(arg('--poster'))); assert.ok(path.isAbsolute(arg('--icon')));
    if (state.behavior === 'reject') throw classifyToyCliError({code: 1,
      stderr: 'Error: status=200 code=307009 message=缺少必要文件 token=DO_NOT_PERSIST_ME'}, 'create');
    if (state.behavior === 'quota') throw classifyToyCliError({code: 1,
      stderr: 'Error: status=200 code=-509 message=今日创建数量已达上限，请明天再试'}, 'create');
    if (state.behavior === 'unknown-no-write') throw new Error('DO_NOT_PERSIST_RAW_PROCESS_ERROR');
    const record = {id: 1000 + state.creates, title: arg('--title'),
      url: `https://www.bilibili.com/toy/${arg('--slug')}/index.html`,
      status: 'reviewing', category: 'TOOL', visibility: 'LINK_ONLY'};
    remote.push(record);
    if (state.behavior === 'unknown-after-write') throw new Error('connection interrupted after possible commit');
    return {id: record.id, status: record.status,
      preview_url: `https://www.bilibili.com/toy/preview/example-${record.id}/index.html`};
  };
  return {run, state, calls, remote};
}

test('dry run validates artifacts without calling any Toy API or enabling sources', async t => {
  const f = await fixture(t), cli = mockCli();
  const result = await publishResourceShards({...f.options, run: cli.run});
  assert.equal(cli.calls.length, 0); assert.equal(result.dryRun, true); assert.equal(result.enabled, false);
  assert.deepEqual(result.tools.map(tool => tool.slug), [slug(1), slug(2)]);
  assert.ok(result.tools.every(tool => tool.visibility === 'LINK_ONLY' && tool.category === 'TOOL' && !tool.enabled));
  await assert.rejects(f.journal(), {code: 'ENOENT'});
});

test('pilot, resume and status refresh create each exact artifact once and keep all sources disabled', async t => {
  const f = await fixture(t), cli = mockCli();
  // Force pagination, with unrelated tools that the publisher may only read.
  const unrelated = Array.from({length: 21}, (_, index) => ({id: index + 1, title: 'Other ' + index,
    url: `https://www.bilibili.com/toy/other-${index}/index.html`, status: 'published', visibility: 'PUBLIC', category: 'GAME'}));
  cli.remote.push(...structuredClone(unrelated));
  const options = {...f.options, run: cli.run, submit: true};
  await publishResourceShards({...options, limit: 1}); assert.equal(cli.state.creates, 1);
  await publishResourceShards(options); assert.equal(cli.state.creates, 2);
  await publishResourceShards(options); assert.equal(cli.state.creates, 2);
  const own = cli.remote.slice(unrelated.length);
  assert.deepEqual(own.map(record => record.title), [title(1), title(2)]);
  assert.ok(cli.calls.some(args => args[0] === 'mylist' && args.includes('2')));
  for (const record of own) record.status = 'published';
  const beforeRefresh = cli.calls.length;
  await publishResourceShards({...f.options, run: cli.run, refreshStatus: true});
  assert.ok(cli.calls.slice(beforeRefresh).every(args => args[0] === 'mylist'));
  assert.equal(cli.state.creates, 2); assert.deepEqual(cli.remote.slice(0, unrelated.length), unrelated);
  const journal = await f.journal();
  assert.ok(journal.packs.every(pack => pack.status === 'published' && pack.id && pack.artifacthash));
  assert.ok(journal.packs.every(pack => pack.publishingMetadata.poster.sha256 && pack.publishingMetadata.icon.sha256));
  assert.ok(journal.stagedSources.every(source => source.enabled === false && source.baseUrl.endsWith('/v2/')));
  const staged = JSON.parse(await fs.readFile(path.join(f.directory, 'staged-sources.json')));
  assert.equal(staged.enabled, false); assert.ok(staged.sources.every(source => source.enabled === false));
});

test('a matching remote address without a local artifact receipt is never reused or overwritten', async t => {
  const f = await fixture(t), cli = mockCli();
  cli.remote.push({id: 9, title: title(1), url: `https://www.bilibili.com/toy/${slug(1)}/index.html`,
    status: 'published', visibility: 'LINK_ONLY', category: 'TOOL'});
  await assert.rejects(publishResourceShards({...f.options, run: cli.run, submit: true}), /没有对应包体日志/);
  assert.equal(cli.state.creates, 0); assert.ok(cli.calls.every(args => args[0] === 'mylist'));
});

test('a confirmed ID is saved before bounded read-only polling for an eventually indexed Toy', async t => {
  const f = await fixture(t, 1), cli = mockCli(), delays = [];
  let postCreateReads = 0;
  const run = async (binary, args) => {
    const result = await cli.run(binary, args);
    if (args[0] === 'mylist' && cli.state.creates) {
      ++postCreateReads;
      const journal = await f.journal();
      assert.equal(journal.packs[0].id, 1001);
      assert.equal(journal.packs[0].state, 'submitted-awaiting-list');
      if (postCreateReads === 1) return {total: 0, list: []};
    }
    return result;
  };
  await publishResourceShards({...f.options, run, submit: true, wait: async milliseconds => delays.push(milliseconds)});
  assert.equal(cli.state.creates, 1); assert.equal(postCreateReads, 2); assert.deepEqual(delays, [750]);
  const journal = await f.journal();
  assert.equal(journal.packs[0].id, 1001); assert.equal(journal.packs[0].state, 'submitted');
  assert.equal(journal.packs[0].attempts.length, 1);
});

test('exhausted list polling retains accepted IDs and continues independent packs without duplicate creates', async t => {
  const f = await fixture(t, 2), cli = mockCli(), delays = [];
  let hide = true, postCreateReads = 0;
  const run = async (binary, args) => {
    const result = await cli.run(binary, args);
    if (hide && args[0] === 'mylist' && cli.state.creates) {++postCreateReads; return {total: 0, list: []};}
    return result;
  };
  const options = {...f.options, run, submit: true, wait: async milliseconds => delays.push(milliseconds)};
  const accepted = await publishResourceShards(options);
  let journal = await f.journal();
  assert.equal(journal.packs[0].id, 1001); assert.equal(journal.packs[0].state, 'submitted-awaiting-list');
  assert.equal(journal.packs[0].metadataVerified, false); assert.equal(journal.packs[1].id, 1002);
  assert.equal(journal.packs[1].state, 'submitted-awaiting-list'); assert.equal(journal.packs[1].metadataVerified, false);
  assert.equal(postCreateReads, 7); assert.deepEqual(delays, [750, 1500, 750, 1500]); assert.equal(cli.state.creates, 2);
  assert.equal(accepted.submitted, 2); assert.equal(accepted.confirmed, 2); assert.equal(accepted.pendingList, 2);
  assert.equal(accepted.awaitingReview, 2);
  const refreshPending = await publishResourceShards({...options, submit: false, refreshStatus: true});
  assert.equal(refreshPending.pendingList, 2); assert.equal(cli.state.creates, 2);
  hide = false;
  await publishResourceShards(options);
  journal = await f.journal();
  assert.equal(journal.packs[0].state, 'submitted'); assert.equal(journal.packs[0].metadataVerified, true);
  assert.equal(journal.packs[1].metadataVerified, true); assert.equal(cli.state.creates, 2);
});

test('a known ID with mismatched listed metadata stops the batch instead of accepting another tool', async t => {
  const f = await fixture(t, 2), cli = mockCli();
  const run = async (binary, args) => {
    const result = await cli.run(binary, args);
    if (args[0] === 'mylist' && cli.state.creates) result.list[0].visibility = 'PUBLIC';
    return result;
  };
  await assert.rejects(publishResourceShards({...f.options, run, submit: true}), /状态需要核对|不会重复创建/);
  assert.equal(cli.state.creates, 1);
  const journal = await f.journal();
  assert.equal(journal.packs[0].id, 1001); assert.equal(journal.packs[0].metadataVerified, false);
  assert.equal(journal.packs.length, 1);
});

test('an unknown create outcome reconciles once and never repeats create even after media changes', async t => {
  const f = await fixture(t), cli = mockCli(); cli.state.behavior = 'unknown-after-write';
  const options = {...f.options, run: cli.run, submit: true};
  await assert.rejects(publishResourceShards(options), /不会重复创建/);
  let journal = await f.journal();
  assert.equal(journal.packs[0].state, 'unknown'); assert.equal(journal.packs[0].id, undefined);
  assert.equal(journal.packs[0].reconciliationCandidate.id, cli.remote[0].id);
  await fs.writeFile(f.poster, png(120, 90, 30));
  await assert.rejects(publishResourceShards(options), /未重复创建/);
  journal = await f.journal();
  assert.equal(cli.state.creates, 1); assert.equal(journal.packs[0].state, 'unknown');
  assert.equal(journal.stagedSources[0].baseUrl, null);
});

test('exact local proof, 35 objects, ZIP identity and strict 50 MB size gate all run before any API call', async t => {
  for (const fault of ['plan-proof', 'object-count', 'zip-identity', 'size-limit']) {
    await t.test(fault, async t => {
      const f = await fixture(t), cli = mockCli();
      if (fault === 'zip-identity') {
        const bytes = await fs.readFile(f.plan.packs[0].zip); bytes[0] ^= 1;
        await fs.writeFile(f.plan.packs[0].zip, bytes);
      } else if (fault === 'size-limit') {
        f.plan.packs[0].zipBytes = 50_000_000; await f.writePlan();
      } else {
        const proof = JSON.parse(await fs.readFile(f.proofPath));
        if (fault === 'plan-proof') proof.planSha256 = '0'.repeat(64);
        else proof.objects = 34;
        await fs.writeFile(f.proofPath, JSON.stringify(proof));
      }
      await assert.rejects(publishResourceShards({...f.options, run: cli.run, submit: true}));
      assert.equal(cli.calls.length, 0);
    });
  }
});

test('only changed media after an explicit API rejection permits retry and preserves failure history', async t => {
  const f = await fixture(t, 1), cli = mockCli(); cli.state.behavior = 'reject';
  const options = {...f.options, run: cli.run, submit: true};
  await assert.rejects(publishResourceShards(options), /307009.*缺少必要文件/);
  await assert.rejects(publishResourceShards(options), /内容未改变/); assert.equal(cli.state.creates, 1);
  let journal = await f.journal();
  assert.equal(journal.packs[0].state, 'rejected'); assert.equal(journal.packs[0].lastFailure.apiCode, 307009);
  assert.doesNotMatch(JSON.stringify(journal), /DO_NOT_PERSIST_ME/);
  await fs.writeFile(f.poster, png(120, 90, 75)); cli.state.behavior = 'success';
  await publishResourceShards(options); assert.equal(cli.state.creates, 2);
  journal = await f.journal();
  const attempts = journal.packs[0].attempts;
  assert.equal(attempts.length, 2); assert.equal(attempts[0].state, 'rejected');
  assert.equal(attempts[0].lastFailure.apiCode, 307009); assert.equal(attempts[1].state, 'submitted');
  assert.notEqual(attempts[0].publishingMetadataHash, attempts[1].publishingMetadataHash);
});

test('explicit reconciliation of an old unknown outcome preserves both observations before retry', async t => {
  const f = await fixture(t, 1), cli = mockCli(); cli.state.behavior = 'unknown-no-write';
  const options = {...f.options, run: cli.run, submit: true};
  await assert.rejects(publishResourceShards(options));
  const journal = await f.journal(), pack = journal.packs[0];
  assert.equal(pack.state, 'unknown'); assert.doesNotMatch(JSON.stringify(journal), /DO_NOT_PERSIST_RAW_PROCESS_ERROR/);
  // Model the operator importing a separately verified explicit API rejection;
  // the publisher itself must never invent this conclusion from an empty list.
  pack.state = 'rejected'; pack.status = 'api-rejected';
  pack.lastFailure = {outcome: 'rejected', apiCode: 307009, message: '缺少必要文件'};
  await fs.writeFile(path.join(f.directory, 'publication.json'), JSON.stringify(journal));
  await fs.writeFile(f.icon, png(32, 32, 90)); cli.state.behavior = 'success';
  await publishResourceShards(options);
  const attempts = (await f.journal()).packs[0].attempts;
  assert.equal(attempts.length, 3); assert.equal(attempts[0].state, 'unknown');
  assert.equal(attempts[1].lastFailure.apiCode, 307009); assert.equal(attempts[2].state, 'submitted');
});

test('quota rejection stays intact on read-only refresh and default submit never retries it', async t => {
  const f = await fixture(t, 3), cli = mockCli(), options = {...f.options, run: cli.run, submit: true};
  await publishResourceShards({...options, limit: 1}); assert.equal(cli.state.creates, 1);
  cli.state.behavior = 'quota';
  await assert.rejects(publishResourceShards(options), /-509.*今日创建数量已达上限/);
  assert.equal(cli.state.creates, 2);
  const before = (await f.journal()).packs[1];
  assert.equal(before.state, 'rejected'); assert.equal(before.lastFailure.apiCode, -509);
  const callsBefore = cli.calls.length;
  const refreshed = await publishResourceShards({...f.options, run: cli.run, refreshStatus: true});
  assert.ok(cli.calls.slice(callsBefore).every(args => args[0] === 'mylist'));
  assert.equal(refreshed.confirmed, 1); assert.equal(refreshed.quotaRejected, 1);
  assert.equal(refreshed.notSubmitted, 1); assert.equal(refreshed.awaitingReview, 1);
  assert.deepEqual((await f.journal()).packs[1], before);
  await assert.rejects(publishResourceShards(options), /需明确 --submit --retry-quota/);
  assert.equal(cli.state.creates, 2); assert.equal((await f.journal()).packs.length, 2);
});

test('explicit quota retry permits the same artifact/media once and reuses earlier confirmed IDs', async t => {
  const f = await fixture(t, 3), cli = mockCli(), options = {...f.options, run: cli.run, submit: true};
  await publishResourceShards({...options, limit: 1});
  cli.state.behavior = 'quota'; await assert.rejects(publishResourceShards(options), /-509/);
  const prior = (await f.journal()).packs[1], originalFirstId = (await f.journal()).packs[0].id;
  cli.state.behavior = 'success';
  const completed = await publishResourceShards({...options, retryQuota: true});
  assert.equal(cli.state.creates, 4); assert.equal(completed.confirmed, 3);
  assert.equal(completed.quotaRejected, 0); assert.equal(completed.notSubmitted, 0);
  const journal = await f.journal(), retried = journal.packs[1];
  assert.equal(journal.packs[0].id, originalFirstId);
  assert.equal(retried.artifacthash, prior.artifacthash);
  assert.equal(retried.publishingMetadataHash, prior.publishingMetadataHash);
  assert.equal(retried.attempts.length, 2); assert.equal(retried.attempts[0].lastFailure.apiCode, -509);
  assert.equal(retried.attempts[1].state, 'submitted');
  assert.ok(journal.stagedSources.every(source => source.enabled === false));
});

test('a still-active quota causes one explicit retry and stops without reaching later packages', async t => {
  const f = await fixture(t, 2), cli = mockCli(), options = {...f.options, run: cli.run, submit: true};
  cli.state.behavior = 'quota';
  await assert.rejects(publishResourceShards(options), /-509/); assert.equal(cli.state.creates, 1);
  await assert.rejects(publishResourceShards({...options, retryQuota: true}), /-509.*今日创建数量已达上限/);
  assert.equal(cli.state.creates, 2);
  const journal = await f.journal();
  assert.equal(journal.packs.length, 1); assert.equal(journal.packs[0].attempts.length, 2);
  assert.equal(journal.packs[0].state, 'rejected'); assert.equal(journal.packs[0].lastFailure.apiCode, -509);
  await fs.writeFile(f.poster, png(120, 90, 55));
  await assert.rejects(publishResourceShards({...options, retryQuota: true}), /保持原 ZIP、封面和图标/);
  assert.equal(cli.state.creates, 2);
});

test('the quota flag cannot override an unresolved unknown outcome or validation rejection', async t => {
  const f = await fixture(t, 1), cli = mockCli(), options = {...f.options, run: cli.run, submit: true};
  cli.state.behavior = 'unknown-no-write'; await assert.rejects(publishResourceShards(options));
  await assert.rejects(publishResourceShards({...options, retryQuota: true}), /未重复创建/);
  assert.equal(cli.state.creates, 1);
  const other = await fixture(t, 1), rejected = mockCli(); rejected.state.behavior = 'reject';
  const validationOptions = {...other.options, run: rejected.run, submit: true};
  await assert.rejects(publishResourceShards(validationOptions), /307009/);
  await assert.rejects(publishResourceShards({...validationOptions, retryQuota: true}), /内容未改变/);
  assert.equal(rejected.state.creates, 1);
});

test('oversize or invalid publishing images and unsupported CLI media flags cannot trigger upload', async t => {
  for (const fault of ['icon-dimensions', 'icon-bytes', 'image-format', 'missing-cli-flag']) {
    await t.test(fault, async t => {
      const f = await fixture(t), cli = mockCli();
      if (fault === 'icon-dimensions') await fs.writeFile(f.icon, png(1025, 1));
      else if (fault === 'icon-bytes') await fs.writeFile(f.icon, Buffer.alloc(512 * 1024 + 1));
      else if (fault === 'image-format') await fs.writeFile(f.poster, 'an HTML page is not a PNG');
      else cli.state.missingMediaFlag = true;
      await assert.rejects(publishResourceShards({...f.options, run: cli.run, submit: true}));
      assert.equal(cli.state.creates, 0);
    });
  }
});

test('safe CLI diagnostics preserve business causes while distinguishing unknown server/transport outcomes', () => {
  const rejected = classifyToyCliError({code: 1,
    stderr: 'Error: status=200 code=307009 message=缺少必要文件 access_token=SECRET_A {"session_token":"SECRET_B"} https://api.test/path?token=SECRET_C'}, 'create');
  assert.equal(rejected.kind, 'api-rejected'); assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.httpStatus, 200); assert.equal(rejected.apiCode, 307009);
  assert.match(rejected.message, /缺少必要文件/); assert.doesNotMatch(JSON.stringify(rejected.receipt()), /SECRET_[ABC]/);
  const auth = classifyToyCliError({stdout: JSON.stringify({code: 307029, message: '登录态已失效'})}, 'mylist');
  assert.equal(auth.kind, 'auth-required'); assert.equal(auth.outcome, 'rejected');
  const server = classifyToyCliError({stderr: 'status=503 code=300001 message=backend unavailable'}, 'create');
  assert.equal(server.outcome, 'unknown'); assert.equal(server.apiCode, 300001);
  const timeout = classifyToyCliError({killed: true, signal: 'SIGTERM', stderr: 'RAW_SECRET_NO_OUTPUT'}, 'create');
  assert.equal(timeout.kind, 'timeout-unknown'); assert.equal(timeout.outcome, 'unknown');
  assert.doesNotMatch(JSON.stringify(timeout.receipt()), /RAW_SECRET/);
});
