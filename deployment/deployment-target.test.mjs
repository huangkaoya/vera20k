import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {validateDeploymentTarget,assertDeploymentConfig,assertUploadPlanTarget,assertReleaseTarget,loadDeploymentTarget,deploymentIdentity} from './deployment-target.mjs';
import {withDeploymentCredentials} from './cloudflare-upload-auth.mjs';

const target=validateDeploymentTarget({schema:1,accountId:'a143c234b30a44c323ed2f2273c9c9da',bucket:'youlidefuchou-res',profile:'youlidefuchou',objectPrefix:'vera20k/web-native/objects/sha256/'});
const config=()=>({account_id:target.accountId,r2_buckets:[{binding:'NATIVE_DATA',bucket_name:target.bucket}]}),plan=()=>({schema:1,...deploymentIdentity(target),objects:[]});
test('deployment target rejects legacy account/bucket/config/release and unscoped plans',()=>{
  assert.doesNotThrow(()=>assertDeploymentConfig(config(),target,'worker'));
  assert.doesNotThrow(()=>assertUploadPlanTarget(plan(),target));
  assert.doesNotThrow(()=>assertReleaseTarget({deployment:deploymentIdentity(target)},target));
  assert.throws(()=>assertDeploymentConfig({...config(),account_id:'b'.repeat(32)},target,'worker'),/pinned/);
  assert.throws(()=>assertDeploymentConfig({...config(),r2_buckets:[{binding:'NATIVE_DATA',bucket_name:'ra2res'}]},target,'worker'),/pinned/);
  assert.throws(()=>assertDeploymentConfig({...config(),r2_buckets:[{...config().r2_buckets[0],preview_bucket_name:'another-bucket'}]},target,'worker'),/pinned/);
  assert.throws(()=>assertDeploymentConfig({...config(),r2_buckets:[{...config().r2_buckets[0],jurisdiction:'eu'}]},target,'worker'),/pinned/);
  assert.throws(()=>assertDeploymentConfig(config(),target,'upload.wrangler.jsonc'),/pinned/);
  assert.throws(()=>assertUploadPlanTarget({schema:1,bucket:'ra2res',objects:[]},target),/pinned/);
  assert.throws(()=>assertUploadPlanTarget({...plan(),accountId:'b'.repeat(32)},target),/pinned/);
  assert.throws(()=>assertUploadPlanTarget({...plan(),bucket:'ra2res'},target),/pinned/);
  assert.throws(()=>assertUploadPlanTarget({...plan(),objectPrefix:'other/'},target),/pinned/);
  assert.throws(()=>assertReleaseTarget({deployment:{...deploymentIdentity(target),bucket:'ra2res'}},target),/pinned/);
});
test('loading target validates both local Wrangler configurations without authentication',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'vera-native-target-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const uploadConfig={...config(),r2_buckets:[{...config().r2_buckets[0],remote:true}]};
  for(const [name,value] of [['target.json',target],['wrangler.jsonc',config()],['upload.wrangler.jsonc',uploadConfig]])await fs.writeFile(path.join(directory,name),JSON.stringify(value));
  assert.deepEqual(await loadDeploymentTarget({baseDirectory:directory}),target);
  await fs.writeFile(path.join(directory,'upload.wrangler.jsonc'),JSON.stringify({...config(),account_id:'b'.repeat(32)}));
  await assert.rejects(loadDeploymentTarget({baseDirectory:directory}),/upload.wrangler.jsonc.*pinned/);
});

const token='fixture-oauth-credential-do-not-log';
const inherited=()=>({CLOUDFLARE_API_TOKEN:'old-token',CF_API_TOKEN:'old-alias',CLOUDFLARE_API_KEY:'old-key',CF_API_KEY:'old-key-alias',CLOUDFLARE_EMAIL:'old-email',CF_EMAIL:'old-email-alias',CLOUDFLARE_ACCOUNT_ID:'old-account',CF_ACCOUNT_ID:'old-account-alias',CLOUDFLARE_API_BASE_URL:'https://wrong.invalid',CF_API_BASE_URL:'https://wrong.invalid',CLOUDFLARE_BASE_URL:'https://wrong.invalid',WRANGLER_API_ENVIRONMENT:'staging',CLOUDFLARE_COMPLIANCE_REGION:'fedramp_high',WRANGLER_AUTH_URL:'https://wrong.invalid',WRANGLER_TOKEN_URL:'https://wrong.invalid',PATH:'/usr/bin'});
const authResult=async()=>({stdout:JSON.stringify({type:'oauth',token})});
const verified=async()=>({ok:true,json:async()=>({success:true,result:{id:target.accountId}})});
test('explicit upload resolves only a named profile with logging disabled, pins account and restores environment',async()=>{
  const env=inherited(),before={...env};let executed=0,verifiedAccount=0;
  const result=await withDeploymentCredentials(target,async({profile})=>{
    executed++;
    assert.equal(profile,'youlidefuchou');assert.equal(env.CLOUDFLARE_API_TOKEN,token);assert.equal(env.CLOUDFLARE_ACCOUNT_ID,target.accountId);
    assert.equal(env.CF_API_TOKEN,undefined);assert.equal(env.CLOUDFLARE_API_KEY,undefined);assert.equal(env.CLOUDFLARE_EMAIL,undefined);assert.equal(env.CF_ACCOUNT_ID,undefined);
    assert.equal(env.CLOUDFLARE_API_BASE_URL,undefined);assert.equal(env.WRANGLER_AUTH_URL,undefined);assert.equal(env.WRANGLER_WRITE_LOGS,'false');
    return 'uploaded';
  },{env,run:async(command,args,options)=>{
    assert.equal(command,process.execPath);assert.ok(args.includes('--profile=youlidefuchou'));assert.deepEqual(args.slice(-3),['auth','token','--json']);
    assert.equal(options.cwd,path.dirname(args[0]).replace(/\/node_modules\/wrangler\/bin$/,''));
    for(const key of Object.keys(before).filter(key=>key!=='PATH'))assert.equal(options.env[key],undefined,key);
    assert.equal(options.env.WRANGLER_WRITE_LOGS,'false');assert.equal(options.env.WRANGLER_LOG_SANITIZE,'true');
    return authResult();
  },fetchImpl:async(url,options)=>{
    verifiedAccount++;
    assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${target.accountId}`);
    assert.equal(options.headers.Authorization,`Bearer ${token}`);assert.equal(options.redirect,'error');
    // Inherited credentials are unchanged until the account verification passes.
    assert.deepEqual(env,before);return verified();
  }});
  assert.equal(result,'uploaded');assert.equal(executed,1);assert.equal(verifiedAccount,1);assert.deepEqual(env,before);
});
test('profile override is explicit, but a foreign or unreadable account never reaches the upload operation',async()=>{
  for(const failure of [async()=>({ok:false}),async()=>({ok:true,json:async()=>({success:true,result:{id:'b'.repeat(32)}})}),async()=>{throw new Error(token);}]){
    const env={...inherited(),VERA_CLOUDFLARE_PROFILE:'other-authorized-profile'},before={...env};let executed=false;
    await assert.rejects(withDeploymentCredentials(target,async()=>{executed=true;},{env,run:async(_command,args)=>{
      assert.ok(args.includes('--profile=other-authorized-profile'));return authResult();
    },fetchImpl:failure}),error=>!/fixture-oauth/.test(String(error))&&/account/.test(error.message)&&!error.cause);
    assert.equal(executed,false);assert.deepEqual(env,before);
  }
});
test('credential resolver failures never expose captured stdout/stderr or call account/upload APIs',async()=>{
  for(const run of [async()=>{throw Object.assign(new Error(token),{stdout:token,stderr:token});},async()=>({stdout:token}),async()=>({stdout:JSON.stringify({type:'api_key',key:token,email:token})})]){
    const env=inherited(),before={...env};
    await assert.rejects(withDeploymentCredentials(target,async()=>assert.fail('must not upload'),{env,run,fetchImpl:async()=>assert.fail('must not query account')}),error=>error.message==='Unable to resolve the named Cloudflare deployment profile'&&!String(error.stack).includes(token)&&!error.cause);
    assert.deepEqual(env,before);
  }
});
test('upload errors redact the active token and restore previous credentials after failure',async()=>{
  const env=inherited(),before={...env};
  await assert.rejects(withDeploymentCredentials(target,async()=>{throw Object.assign(new Error(`upload failed ${token}`),{stdout:token,stderr:token});},{env,run:authResult,fetchImpl:verified}),error=>error.message==='upload failed [redacted]'&&!String(error.stack).includes(token)&&!error.cause);
  assert.deepEqual(env,before);
});
