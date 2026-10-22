import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));
export function validateDeploymentTarget(target) {
  if(target?.schema!==1||!/^[a-f0-9]{32}$/.test(target.accountId)||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(target.bucket)||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target.profile)||
    target.objectPrefix!=='vera20k/web-native/objects/sha256/')throw new Error('Invalid native deployment target');
  return Object.freeze({...target});
}
export function assertDeploymentConfig(config,target,label) {
  const buckets=config?.r2_buckets;
  if(config?.account_id!==target.accountId||!Array.isArray(buckets)||buckets.length!==1||
    buckets[0].binding!=='NATIVE_DATA'||buckets[0].bucket_name!==target.bucket||
    buckets[0].account_id&&buckets[0].account_id!==target.accountId||
    buckets[0].preview_bucket_name&&buckets[0].preview_bucket_name!==target.bucket||
    buckets[0].jurisdiction&&buckets[0].jurisdiction!=='default'||
    label==='upload.wrangler.jsonc'&&buckets[0].remote!==true)
    throw new Error(`${label} does not match the pinned native deployment account/bucket`);
}
export function assertUploadPlanTarget(plan,target) {
  if(plan?.schema!==1||plan.accountId!==target.accountId||plan.bucket!==target.bucket||
    plan.objectPrefix!==target.objectPrefix||!Array.isArray(plan.objects))
    throw new Error('Upload plan does not match the pinned native deployment account/bucket');
}
export function assertReleaseTarget(release,target) {
  const actual=release?.deployment;
  if(actual?.accountId!==target.accountId||actual.bucket!==target.bucket||actual.objectPrefix!==target.objectPrefix)
    throw new Error('Release does not match the pinned native deployment account/bucket');
}
export async function loadDeploymentTarget({baseDirectory=directory}={}) {
  // These JSONC configs deliberately use strict JSON, so local validation does
  // not initialize Wrangler or resolve authentication in the plan-only path.
  const read=async name=>JSON.parse(await fs.readFile(path.join(baseDirectory,name),'utf8'));
  const target=validateDeploymentTarget(await read('target.json'));
  for(const file of ['wrangler.jsonc','upload.wrangler.jsonc'])assertDeploymentConfig(await read(file),target,file);
  return target;
}
export function deploymentIdentity(target) {
  return {accountId:target.accountId,bucket:target.bucket,objectPrefix:target.objectPrefix};
}
