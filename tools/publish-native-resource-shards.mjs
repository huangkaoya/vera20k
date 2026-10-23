import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify, isDeepStrictEqual} from 'node:util';
import {hashNativeFile} from './native-build-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile), digest = bytes => createHash('sha256').update(bytes).digest('hex');
const maximumZipBytes = 50_000_000;
const shaPattern = /^[a-f0-9]{64}$/;

export function publicationDescriptor(plan, pack, index) {
  const ordinal = String(index + 1).padStart(2, '0');
  const slug = `werhd-yuri-res-${plan.catalogIdentity.slice(0, 8)}-${ordinal}`;
  const artifact = {catalogIdentity: plan.catalogIdentity, packId: pack.packId,
    zipBytes: pack.zipBytes, zipSha256: pack.zipSha256, manifestSha256: pack.manifestSha256};
  return {packId: pack.packId, ordinal, slug, title: `尤里版资源校验工具 ${ordinal}`,
    category: 'TOOL', visibility: 'LINK_ONLY', theme: 'dark', enabled: false,
    artifact, artifacthash: digest(JSON.stringify(artifact)),
    baseUrl: `https://www.bilibilitoy.com/toy/${slug}/v2/`, manifestPath: 'manifest.json'};
}

export function toySlug(record) {
  if (typeof record?.url !== 'string') return null;
  try {
    const url = new URL(record.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['www.bilibili.com', 'www.bilibilitoy.com', 'bilibilitoy.com'].includes(url.hostname)) return null;
    return /^\/toy\/([A-Za-z0-9_-]+)\/index\.html$/.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}

export function matchingToy(records, descriptor) {
  const matches = records.filter(record => toySlug(record) === descriptor.slug);
  if (matches.length > 1) throw new Error(`多个 Toy 使用同一资源工具地址：${descriptor.slug}`);
  const record = matches[0];
  if (record && record.title !== descriptor.title)
    throw new Error(`资源工具地址已被其他名称占用：${descriptor.slug}`);
  return record ?? null;
}

export function safeToyDiagnostic(value) {
  return String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, match => match.slice(0, match.indexOf(':') + 1) + '[redacted]')
    .replace(/["']?\b(?:token|secret|password|authorization|cookie|session(?:[_-](?:id|token))?|csrf|code_verifier|(?:access|refresh|api)[_-]?(?:token|key))\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      match => match.slice(0, match.search(/[:=]/) + 1) + '[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export class ToyCliFailure extends Error {
  constructor({operation, kind, outcome = 'unknown', apiCode, httpStatus, detail, exitCode, signal, stage, reason}) {
    const code = apiCode !== undefined ? ` code=${apiCode}` : '';
    const status = httpStatus ? ` HTTP=${httpStatus}` : '';
    const safeStage = ['upload-init', 'upload-part', 'upload-complete', 'preview', 'create'].includes(stage) ? stage : null;
    const safeReason = ['timeout', 'network'].includes(reason) ? reason : null;
    const transport = `${safeStage ? ` stage=${safeStage}` : ''}${safeReason ? ` reason=${safeReason}` : ''}`;
    const info = safeToyDiagnostic(detail);
    super(`Toy ${operation} ${kind}${status}${code}${transport}${info ? `：${info}` : ''}`);
    Object.assign(this, {name: 'ToyCliFailure', operation, kind, outcome,
      ...(apiCode !== undefined ? {apiCode} : {}), ...(httpStatus ? {httpStatus} : {}),
      ...(Number.isInteger(exitCode) ? {exitCode} : {}), ...(signal ? {signal} : {}),
      ...(safeStage ? {stage: safeStage} : {}), ...(safeReason ? {reason: safeReason} : {})});
  }
  receipt() {
    return {operation: this.operation, kind: this.kind, outcome: this.outcome,
      message: this.message, ...(this.apiCode !== undefined ? {apiCode: this.apiCode} : {}),
      ...(this.httpStatus ? {httpStatus: this.httpStatus} : {}),
      ...(this.exitCode !== undefined ? {exitCode: this.exitCode} : {}),
      ...(this.signal ? {signal: this.signal} : {}), ...(this.stage ? {stage: this.stage} : {}),
      ...(this.reason ? {reason: this.reason} : {})};
  }
}

function transportDiagnostic(error) {
  // These literal prefixes occur in the official v0.6.4 CLI. Recognize only
  // an error line's prefix, never a response body or an embedded URL/message.
  const line = typeof error?.stderr === 'string' ? error.stderr.split(/\r?\n/).find(value =>
    /^(?:Error:\s*)?(?:upload\/(?:init|parts|part \d+|complete) failed:|(?:preview|create) Toy failed:)/.test(value)) : null;
  const prefix = line?.replace(/^Error:\s*/, ''), diagnostic = {};
  if (prefix?.startsWith('upload/init failed:')) diagnostic.stage = 'upload-init';
  else if (/^upload\/(?:parts|part \d+) failed:/.test(prefix ?? '')) diagnostic.stage = 'upload-part';
  else if (prefix?.startsWith('upload/complete failed:')) diagnostic.stage = 'upload-complete';
  else if (prefix?.startsWith('preview Toy failed:')) diagnostic.stage = 'preview';
  else if (prefix?.startsWith('create Toy failed:')) diagnostic.stage = 'create';
  if (error?.killed || /context deadline exceeded|Client\.Timeout|\bi\/o timeout\b|TLS handshake timeout/i.test(line ?? ''))
    diagnostic.reason = 'timeout';
  else if (/\bdial (?:tcp|udp)\b|connection (?:reset by peer|refused)|network is unreachable|no such host|unexpected EOF/i.test(line ?? ''))
    diagnostic.reason = 'network';
  return diagnostic;
}

function apiFailure(operation, apiCode, message, httpStatus, exitCode) {
  return new ToyCliFailure({operation, apiCode, httpStatus, exitCode,
    kind: [307001, 307029].includes(apiCode) ? 'auth-required' : 'api-rejected',
    outcome: !httpStatus || httpStatus < 500 ? 'rejected' : 'unknown', detail: message});
}

export function classifyToyCliError(error, operation) {
  if (error instanceof ToyCliFailure) return error;
  // Inspect only documented API error fields; never publish raw process output.
  for (const output of [error?.stdout, error?.stderr]) {
    if (typeof output !== 'string') continue;
    try {
      const parsed = JSON.parse(output), item = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
      if (Number.isInteger(item?.code) && item.code !== 0 && typeof item.message === 'string')
        return apiFailure(operation, item.code, item.message, Number(item.status) || undefined,
          Number.isInteger(error.code) ? error.code : undefined);
    } catch {}
    // Official error-codes.md documents: status=<n> code=<code> message=<message>.
    const match = /(?:status\s*[=:]\s*(\d{3})\s+)?code\s*[=:]\s*(-?\d+)\s+message\s*[=:]\s*([^\r\n]+)/i.exec(output);
    if (match && Number(match[2]) !== 0)
      return apiFailure(operation, Number(match[2]), match[3], match[1] ? Number(match[1]) : undefined,
        Number.isInteger(error.code) ? error.code : undefined);
    const local = /(?:Error:\s*)?((?:unknown flag:|required flag\(s\)|accepts \d+ arg\(s\)|入口 index\.html[^\r\n]*|图片[^\r\n]*)(?:[^\r\n]*))/i.exec(output);
    if (local) return new ToyCliFailure({operation, kind: 'local-validation', outcome: 'rejected', detail: local[1],
      exitCode: Number.isInteger(error.code) ? error.code : undefined});
    if (/登录态已失效|请执行\s+`?toy login/i.test(output))
      return new ToyCliFailure({operation, kind: 'auth-required', outcome: 'rejected', detail: '登录态已失效，请执行 toy login；未自动登录。'});
  }
  const code = typeof error?.code === 'string' ? error.code : undefined;
  if (['ENOENT', 'EACCES'].includes(code))
    return new ToyCliFailure({operation, kind: 'local-execution', outcome: 'rejected', detail: code});
  return new ToyCliFailure({operation, kind: error?.killed ? 'timeout-unknown' : 'transport-unknown',
    exitCode: Number.isInteger(error?.code) ? error.code : undefined,
    signal: typeof error?.signal === 'string' ? safeToyDiagnostic(error.signal) : undefined,
    ...transportDiagnostic(error),
    detail: '未取得可确认的提交结果；已保留结果核对边界，不自动重试。'});
}

function unwrapped(value, operation = 'API') {
  if (value && Object.hasOwn(value, 'code') && value.code !== 0)
    throw apiFailure(operation, Number(value.code) || -1, value.message);
  return value?.data && typeof value.data === 'object' ? value.data : value;
}

/** CLI output is parsed in memory. Tokens, raw stderr and user profiles are
 * never copied into the publication journal or console output. */
export async function runToyCli(cli, args) {
  try {
    const result = await exec(cli, args, {cwd: root, encoding: 'utf8',
      timeout: args[0] === 'create' ? 20 * 60 * 1000 : 60000, maxBuffer: 2 * 1024 * 1024});
    return unwrapped(JSON.parse(result.stdout), args[0]);
  } catch (error) {
    // execFile errors can carry the complete stdout/stderr. Do not propagate
    // them or attach them as causes to a public error.
    throw classifyToyCliError(error, args[0]);
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  await fs.rename(temporary, file);
}

function ownedFile(file, outputDirectory, label) {
  if (typeof file !== 'string') throw new Error(`资源上传计划缺少 ${label}`);
  const resolved = path.resolve(root, file);
  const relative = path.relative(outputDirectory, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`${label} 必须位于资源上传目录中`);
  return resolved;
}

/** Local admission is repeated before every explicit submission invocation.
 * The HTTP/browser proof is bound to the exact plan bytes, not just catalog ID.
 */
export async function validatePublicationPlan({planPath = path.join(root, 'dist/toy-resources/plan.json'),
  proofPath = path.join(root, 'validation/toy-resource-http.json'), requireProof = true} = {}) {
  const bytes = await fs.readFile(planPath), plan = JSON.parse(bytes), outputDirectory = path.dirname(planPath);
  if (plan.schema !== 1 || plan.kind !== 'werhd-toy-resource-upload-plan' || plan.enabled !== false ||
    !shaPattern.test(plan.catalogIdentity) || !shaPattern.test(plan.requiredResourceIdentity) ||
    !Array.isArray(plan.packs) || !plan.packs.length || !Array.isArray(plan.stagedSources) ||
    plan.stagedSources.length !== plan.packs.length || plan.stagedSources.some(source => source.enabled !== false))
    throw new Error('资源上传计划无效或已启用 Toy 来源');
  const packIds = new Set();
  for (const pack of plan.packs) {
    if (typeof pack.packId !== 'string' || !pack.packId || packIds.has(pack.packId) ||
      !Number.isSafeInteger(pack.zipBytes) || pack.zipBytes <= 0 || pack.zipBytes >= maximumZipBytes ||
      !shaPattern.test(pack.zipSha256) || !shaPattern.test(pack.manifestSha256))
      throw new Error('资源包必须有独立标识、SHA，并且 ZIP 严格小于 50,000,000 字节');
    packIds.add(pack.packId);
    const archive = ownedFile(pack.zip, outputDirectory, 'ZIP'), stat = await fs.lstat(archive);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pack.zipBytes ||
      await hashNativeFile(archive) !== pack.zipSha256)
      throw new Error(`资源 ZIP 校验失败：${pack.packId}`);
    const directory = ownedFile(pack.directory, outputDirectory, '工具目录');
    const manifest = path.join(directory, 'v2/manifest.json'), manifestStat = await fs.lstat(manifest);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() ||
      await hashNativeFile(manifest) !== pack.manifestSha256)
      throw new Error(`资源清单校验失败：${pack.packId}`);
  }
  const planSha256 = digest(bytes);
  if (requireProof) {
    const proof = await readJson(proofPath);
    const objectCount = Array.isArray(proof.objects) ? proof.objects.length : proof.objects;
    if (proof.ok !== true || proof.catalogIdentity !== plan.catalogIdentity || proof.planSha256 !== planSha256 || objectCount !== 35)
      throw new Error('缺少与本次上传计划一致的 35 对象本地 HTTP 验证记录，拒绝上传');
  }
  return {plan, planSha256, outputDirectory};
}

async function listToys(cli, run) {
  const records = [];
  for (let page = 1; page <= 200; page++) {
    const result = unwrapped(await run(cli, ['mylist', '--page', String(page), '--size', '20', '--json']));
    if (!Array.isArray(result?.list) || !Number.isSafeInteger(result.total) || result.total < 0)
      throw new Error('Toy mylist 响应缺少可靠的分页信息');
    records.push(...result.list);
    if (records.length >= result.total) return records;
    if (!result.list.length) throw new Error('Toy 列表分页提前结束，拒绝推测资源工具不存在');
  }
  throw new Error('Toy 列表分页超限，拒绝创建重复工具');
}

function publicFields(record) {
  return {id: record.id, status: record.status, url: record.url,
    visibility: record.visibility, category: record.category};
}

function verifyRemoteMetadata(record, descriptor, id) {
  if (!record || (id !== undefined && String(record.id) !== String(id)) ||
    record.title !== descriptor.title || toySlug(record) !== descriptor.slug ||
    record.visibility !== 'LINK_ONLY' || record.category !== 'TOOL')
    throw new Error(`已提交资源工具的 ID、地址、名称或可见性不符：${descriptor.packId}`);
}

async function reconcileConfirmedToy({cli, run, descriptor, id, wait}) {
  let records = null, lookupFailure = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { records = await listToys(cli, run); }
    catch (error) {
      lookupFailure = classifyToyCliError(error, 'mylist').receipt();
      if (attempt < 2) await wait(750 * (attempt + 1));
      continue;
    }
    const candidate = matchingToy(records, descriptor);
    if (candidate) {
      verifyRemoteMetadata(candidate, descriptor, id);
      return {records, candidate, metadataVerified: true};
    }
    if (attempt < 2) await wait(750 * (attempt + 1));
  }
  // Creation already returned a confirmed ID. A review/index delay cannot
  // turn that acceptance into an upload failure or block independent packs.
  return {records, candidate: null, metadataVerified: false, lookupFailure};
}

function applyListedMetadata(record, candidate) {
  if (candidate) {
    Object.assign(record, publicFields(candidate), {state: 'submitted', metadataVerified: true,
      checkedAt: new Date().toISOString()});
    delete record.listLookupFailure;
  } else {
    Object.assign(record, {state: 'submitted-awaiting-list', metadataVerified: false,
      listCheckedAt: new Date().toISOString()});
  }
}

export function imageDimensions(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.subarray(12, 16).toString() === 'IHDR')
    return {format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    const sof = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) ++offset;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 216) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (sof.has(marker) && length >= 8)
        return {format: 'jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3)};
      offset += length;
    }
  }
  throw new Error('发布封面/图标必须是真实 PNG 或 JPEG 图片');
}

export async function validatePublishingMedia({poster, icon}) {
  const media = {};
  for (const [kind, input] of Object.entries({poster, icon})) {
    if (typeof input !== 'string' || !input) throw new Error(`缺少 ${kind} 发布图片`);
    const file = path.resolve(root, input), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size >= maximumZipBytes)
      throw new Error(`发布图片必须是小于 50 MB 的普通文件：${kind}`);
    if (kind === 'icon' && stat.size > 512 * 1024) throw new Error('Toy 图标超过 512 KB');
    const bytes = await fs.readFile(file), dimensions = imageDimensions(bytes);
    if (!dimensions.width || !dimensions.height || dimensions.width >= 10000 || dimensions.height >= 10000 ||
      kind === 'icon' && (dimensions.width > 1024 || dimensions.height > 1024))
      throw new Error(`发布图片尺寸不符合 Toy 限制：${kind}`);
    media[kind] = {path: file, bytes: stat.size, sha256: digest(bytes), ...dimensions};
  }
  return {media, mediaHash: digest(JSON.stringify({poster: media.poster.sha256, icon: media.icon.sha256}))};
}

export function canRetryRejectedPublication(record, descriptor, publishing, candidate, {retryQuota = false} = {}) {
  if (record.artifacthash !== descriptor.artifacthash)
    throw new Error(`重试的资源 ZIP 与已记录包体不一致：${descriptor.packId}`);
  if (record.state !== 'rejected' || record.lastFailure?.outcome !== 'rejected' || record.id || candidate)
    throw new Error(`先前结果并非无 ID、无线上 Toy 的明确拒绝，禁止再次创建：${descriptor.slug}`);
  if (record.lastFailure.apiCode === -509) {
    if (!retryQuota)
      throw new Error(`Toy 今日创建配额已拒绝此包；次日恢复后需明确 --submit --retry-quota，不自动重试：${descriptor.slug}`);
    if (!publishing || record.publishingMetadataHash !== publishing.mediaHash)
      throw new Error(`配额恢复必须保持原 ZIP、封面和图标内容，不通过改包或改图重试：${descriptor.slug}`);
    return true;
  }
  if (!publishing || record.publishingMetadataHash === publishing.mediaHash)
    throw new Error(`明确拒绝后的发布封面/图标内容未改变，不自动重试：${descriptor.slug}`);
  return true;
}

function snapshotAttempt(record) {
  const fields = ['state', 'status', 'startedAt', 'submittedAt', 'id', 'lastFailure', 'lastError',
    'publishingMetadataHash', 'publishingMetadata', 'reconciliationCheckedAt', 'reconciliationCandidate',
    'metadataVerified', 'listCheckedAt', 'listLookupFailure'];
  return Object.fromEntries(fields.filter(field => record[field] !== undefined).map(field => [field, structuredClone(record[field])]));
}

export async function publishResourceShards({submit = false, refreshStatus = false, retryQuota = false, from = 1, limit = Infinity,
  cli = path.join(root, '.build/toy-cli/toy'), run = runToyCli,
  planPath = path.join(root, 'dist/toy-resources/plan.json'),
  proofPath = path.join(root, 'validation/toy-resource-http.json'), poster, icon,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), onProgress = console.log} = {}) {
  if (submit && refreshStatus) throw new Error('--submit 和 --refresh-status 不能同时使用');
  if (retryQuota && !submit) throw new Error('--retry-quota 仅能搭配显式 --submit 使用');
  if (!Number.isSafeInteger(from) || from < 1) throw new Error('--from 必须是原计划中从 1 开始的正整数序号');
  if (!(limit === Infinity || Number.isSafeInteger(limit) && limit > 0)) throw new Error('--limit 必须是正整数');
  const {plan, planSha256, outputDirectory} = await validatePublicationPlan({planPath, proofPath, requireProof: submit});
  if (from > plan.packs.length || from > limit) throw new Error('--from 不能超过资源包总数或 --limit');
  const publishing = refreshStatus ? null : await validatePublishingMedia({
    poster: poster ?? path.join(outputDirectory, 'media/poster.png'),
    icon: icon ?? path.join(outputDirectory, 'media/icon.png')});
  const descriptors = plan.packs.map((pack, index) => publicationDescriptor(plan, pack, index));
  if (!submit && !refreshStatus) {
    const preview = {dryRun: true, from, catalogIdentity: plan.catalogIdentity, planSha256,
      packages: plan.packs.length, zipBytes: plan.packs.reduce((sum, pack) => sum + pack.zipBytes, 0),
      publishingMetadata: publishing.media, publishingMetadataHash: publishing.mediaHash,
      enabled: false, tools: descriptors.map(({artifact, ...descriptor}) => descriptor)};
    onProgress(JSON.stringify(preview, null, 2));
    return preview;
  }
  const journalPath = path.join(outputDirectory, 'publication.json');
  const journal = await readJson(journalPath, {schema: 1, kind: 'werhd-toy-resource-publication',
    catalogIdentity: plan.catalogIdentity, planSha256, enabled: false, packs: []});
  if (journal.schema !== 1 || journal.kind !== 'werhd-toy-resource-publication' ||
    journal.catalogIdentity !== plan.catalogIdentity || journal.planSha256 !== planSha256 ||
    journal.enabled !== false || !Array.isArray(journal.packs))
    throw new Error('发布日志与本次计划不一致；保留日志并人工检查，禁止重复创建');
  const ids = new Set();
  for (const record of journal.packs) {
    if (ids.has(record.packId)) throw new Error('发布日志包含重复资源包');
    ids.add(record.packId);
  }
  let remote = await listToys(cli, run);
  // Check every destination before starting any upload, so a conflict in a later
  // pack cannot leave a partially published batch that already needed review.
  for (const descriptor of descriptors) {
    const existing = journal.packs.find(record => record.packId === descriptor.packId);
    if (existing && existing.artifacthash !== descriptor.artifacthash)
      throw new Error(`发布日志中的包体已变化，拒绝覆盖或重复发布：${descriptor.packId}`);
    // A status refresh observes confirmed IDs. It must retain negative/unknown
    // receipts for no-ID attempts without turning them into another outcome.
    if (refreshStatus && !existing?.id) continue;
    const candidate = matchingToy(remote, descriptor);
    if (!existing && candidate)
      throw new Error(`该地址已有 Toy，但没有对应包体日志，不能假定内容一致：${descriptor.slug}`);
    if (submit && existing && !existing.id && existing.state === 'rejected')
      canRetryRejectedPublication(existing, descriptor, publishing, candidate, {retryQuota});
  }
  if (submit) {
    const help = await run(cli, ['create', '--help-json']);
    const create = help.commands?.find(command => command.path?.join('/') === 'create');
    const choices = name => create?.flags?.find(flag => flag.name === name)?.choices ?? [];
    if (!choices('category').includes('TOOL') || !choices('visibility').includes('link-only') ||
      !['yes', 'poster', 'icon'].every(name => create.flags.some(flag => flag.name === name)))
      throw new Error('当前 Toy CLI 不支持已检查的工具/链接可见/发布图片提交参数');
  }
  const persist = async () => {
    journal.updatedAt = new Date().toISOString();
    journal.stagedSources = descriptors.map(descriptor => {
      const published = journal.packs.find(record => record.packId === descriptor.packId);
      return {packId: descriptor.packId, enabled: false,
        baseUrl: published?.id ? descriptor.baseUrl : null, manifestPath: descriptor.manifestPath,
        manifestSha256: descriptor.artifact.manifestSha256, id: published?.id ?? null,
        status: published?.status ?? 'not-submitted'};
    });
    await writeAtomic(journalPath, journal);
    await writeAtomic(path.join(outputDirectory, 'staged-sources.json'), {schema: 1, enabled: false,
      catalogIdentity: plan.catalogIdentity, sources: journal.stagedSources});
  };
  let submitted = 0;
  for (let index = from - 1; index < plan.packs.length && index < limit; index++) {
    const pack = plan.packs[index], descriptor = descriptors[index];
    let record = journal.packs.find(value => value.packId === pack.packId);
    if (refreshStatus && !record?.id) {
      if (record) onProgress(JSON.stringify({packId: pack.packId, preservedReceipt: true,
        state: record.state, status: record.status, apiCode: record.lastFailure?.apiCode ?? null}));
      continue;
    }
    let candidate = matchingToy(remote, descriptor);
    if (record) {
      if (record.id && ['submitted', 'submitted-awaiting-list'].includes(record.state)) {
        if (!candidate) {
          const reconciled = await reconcileConfirmedToy({cli, run, descriptor, id: record.id, wait});
          if (reconciled.records) remote = reconciled.records;
          candidate = reconciled.candidate;
          if (reconciled.lookupFailure) record.listLookupFailure = reconciled.lookupFailure;
        }
        if (candidate) verifyRemoteMetadata(candidate, descriptor, record.id);
        applyListedMetadata(record, candidate);
        await persist();
        onProgress(JSON.stringify({packId: pack.packId, reusedJournal: true, id: record.id, status: record.status,
          metadataVerified: record.metadataVerified, pendingList: !record.metadataVerified}));
        continue;
      }
      if (submit && record.state === 'rejected') {
        canRetryRejectedPublication(record, descriptor, publishing, candidate, {retryQuota});
        onProgress(JSON.stringify({packId: pack.packId, retryingKnownRejection: true,
          previousApiCode: record.lastFailure.apiCode,
          publishingMetadataChanged: record.publishingMetadataHash !== publishing.mediaHash,
          explicitQuotaRetry: retryQuota && record.lastFailure.apiCode === -509}));
      } else {
        if (candidate) record.reconciliationCandidate = publicFields(candidate);
        if (record.state !== 'rejected') record.state = 'unknown';
        await persist();
        throw new Error(`先前提交结果需要核对，未重复创建：${record.lastFailure?.message ?? descriptor.slug}`);
      }
    }
    if (refreshStatus) continue;
    // List again immediately before each mutation. A concurrent human action
    // after the batch preflight must not be silently overwritten or duplicated.
    remote = await listToys(cli, run);
    candidate = matchingToy(remote, descriptor);
    if (candidate) throw new Error(`上传前发现同地址 Toy，停止以避免重复：${descriptor.slug}`);
    for (const item of Object.values(publishing.media))
      if (await hashNativeFile(item.path) !== item.sha256) throw new Error('发布图片在准备期间发生变化，拒绝上传');
    if (record) {
      if (!Array.isArray(record.attempts)) record.attempts = [];
      const priorAttempt = snapshotAttempt(record);
      // Reconciliation can change a formerly unknown result into an explicit
      // rejection. Preserve both observations instead of rewriting old history.
      if (!record.attempts.length || !isDeepStrictEqual(record.attempts.at(-1), priorAttempt))
        record.attempts.push(priorAttempt);
      Object.assign(record, {state: 'submitting', status: 'outcome-pending', startedAt: new Date().toISOString()});
      delete record.lastFailure; delete record.lastError;
    } else {
      record = {...descriptor, zip: pack.zip, state: 'submitting', status: 'outcome-pending',
        startedAt: new Date().toISOString(), attempts: []};
      journal.packs.push(record);
    }
    record.publishingMetadata = publishing.media;
    record.publishingMetadataHash = publishing.mediaHash;
    record.attempts.push(snapshotAttempt(record));
    await persist();
    onProgress(JSON.stringify({packId: pack.packId, submitting: true, zipBytes: pack.zipBytes, slug: descriptor.slug}));
    try {
      const result = unwrapped(await run(cli, ['create', path.resolve(root, pack.zip),
        '--category', 'TOOL', '--visibility', 'link-only', '--theme', 'dark',
        '--poster', publishing.media.poster.path, '--icon', publishing.media.icon.path,
        '--title', descriptor.title, '--slug', descriptor.slug, '--json', '--yes']));
      if (!(typeof result?.id === 'number' && Number.isSafeInteger(result.id) || typeof result?.id === 'string' && /^\d+$/.test(result.id)) ||
        typeof result.status !== 'string' || !result.status)
        throw new ToyCliFailure({operation: 'create', kind: 'receipt-invalid',
          detail: 'Toy create 响应缺少可确认的 ID/status；结果仍不确定。'});
      Object.assign(record, {id: result.id, status: result.status,
        preview_url: typeof result.preview_url === 'string' ? result.preview_url : null,
        url: typeof result.url === 'string' ? result.url : `https://www.bilibili.com/toy/${descriptor.slug}/index.html`,
        state: 'submitted-awaiting-list', metadataVerified: false, submittedAt: new Date().toISOString()});
      Object.assign(record.attempts.at(-1), snapshotAttempt(record));
      // Persist the confirmed create receipt before any follow-up network call.
      await persist();
      const reconciled = await reconcileConfirmedToy({cli, run, descriptor, id: record.id, wait});
      if (reconciled.records) remote = reconciled.records;
      candidate = reconciled.candidate;
      if (reconciled.lookupFailure) record.listLookupFailure = reconciled.lookupFailure;
      applyListedMetadata(record, candidate);
      Object.assign(record.attempts.at(-1), snapshotAttempt(record));
      await persist();
      ++submitted;
      onProgress(JSON.stringify({packId: pack.packId, id: record.id, status: record.status,
        visibility: record.visibility, category: record.category, preview_url: record.preview_url, url: record.url,
        metadataVerified: record.metadataVerified, pendingList: !record.metadataVerified}));
    } catch (error) {
      const failure = classifyToyCliError(error, 'create');
      record.lastFailure = failure.receipt();
      if (!record.id) {
        record.state = failure.outcome === 'rejected' ? 'rejected' : 'unknown';
        record.status = failure.outcome === 'rejected' ? 'submission-rejected' : 'outcome-unknown';
        await persist();
        try {
          remote = await listToys(cli, run);
          candidate = matchingToy(remote, descriptor);
          if (candidate) record.reconciliationCandidate = publicFields(candidate);
          record.reconciliationCheckedAt = new Date().toISOString();
        } catch { record.reconciliationUnavailable = true; }
      }
      record.lastError = record.id ? 'submitted-requires-platform-reconciliation'
        : failure.outcome === 'rejected' ? 'submission-rejected-no-automatic-retry' : 'unknown-outcome-no-automatic-retry';
      Object.assign(record.attempts.at(-1), snapshotAttempt(record));
      await persist();
      throw new Error(`资源工具 ${descriptor.ordinal}：${failure.message} 已保留日志并停止；不会重复创建。`);
    }
  }
  await persist();
  const result = {ok: true, submit, refreshStatus, from, submitted, catalogIdentity: plan.catalogIdentity,
    journal: journalPath, packages: plan.packs.length, recorded: journal.packs.length,
    enabled: false, confirmed: journal.packs.filter(record => record.id).length,
    pendingList: journal.packs.filter(record => record.id && record.metadataVerified !== true).length,
    quotaRejected: journal.packs.filter(record => !record.id && record.state === 'rejected'
      && record.lastFailure?.outcome === 'rejected' && record.lastFailure.apiCode === -509).length,
    notSubmitted: plan.packs.filter(pack => !journal.packs.some(record => record.packId === pack.packId)).length,
    awaitingReview: journal.packs.filter(record => record.id && record.status !== 'published').length};
  onProgress(JSON.stringify(result));
  return result;
}

function argumentsFrom(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--submit') options.submit = true;
    else if (arg === '--refresh-status') options.refreshStatus = true;
    else if (arg === '--retry-quota') options.retryQuota = true;
    else if (arg === '--dry-run') continue;
    else if (/^--from=\d+$/.test(arg)) options.from = Number(arg.slice(7));
    else if (/^--limit=\d+$/.test(arg)) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--cli=')) options.cli = path.resolve(arg.slice(6));
    else if (arg.startsWith('--poster=')) options.poster = path.resolve(arg.slice(9));
    else if (arg.startsWith('--icon=')) options.icon = path.resolve(arg.slice(7));
    else if (['--poster', '--icon'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少图片路径`);
      options[arg.slice(2)] = path.resolve(value);
    }
    else throw new Error(`未知发布参数：${arg}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await publishResourceShards(argumentsFrom(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
