// Explicit --upload publishes only content-addressed objects in our own new
// prefix. Default invocation validates a plan without touching Cloudflare.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {hashNativeFile,verifyNativeBuild} from '../tools/native-build-manifest.mjs';
import {loadDeploymentTarget,assertUploadPlanTarget,assertReleaseTarget,deploymentIdentity} from './deployment-target.mjs';
import {withDeploymentCredentials} from './cloudflare-upload-auth.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(directory,'..');
const target=await loadDeploymentTarget();
const plan=JSON.parse(await fs.readFile(path.join(directory,'generated/upload-plan.json'),'utf8'));
assertUploadPlanTarget(plan,target);
const release=await fs.readFile(path.join(directory,'generated/release.json'));
if(createHash('sha256').update(release).digest('hex')!==plan.releaseSha256)throw new Error('Release manifest changed after packaging');
assertReleaseTarget(JSON.parse(release),target);
await verifyNativeBuild({root,sourceCheck:true,requireChecked:true});
for(const object of plan.objects) {
  if(object.key!==target.objectPrefix+object.sha256||!/^[a-f0-9]{64}$/.test(object.sha256))throw new Error('Object must use the isolated native content-addressed prefix');
  const stat=await fs.lstat(object.file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==object.bytes||await hashNativeFile(object.file)!==object.sha256)throw new Error('Local upload object differs from its immutable plan');
}
console.log(JSON.stringify({validated:true,objects:plan.objects.length,bytes:plan.objects.reduce((sum,object)=>sum+object.bytes,0),upload:process.argv.includes('--upload')}));
if(!process.argv.includes('--upload'))process.exit(0);
await withDeploymentCredentials(target,async({profile})=>{
const {getPlatformProxy}=await import('wrangler');
const proxy=await getPlatformProxy({configPath:path.join(directory,'upload.wrangler.jsonc'),envFiles:[],persist:false,remoteBindings:true});
const stateRoot=path.join(directory,'generated/upload-state',target.accountId,target.bucket);
const chunkSize=8*1024*1024,md5=bytes=>createHash('md5').update(bytes).digest('hex');
const same=(actual,expected)=>actual&&actual.size===expected.bytes&&actual.customMetadata?.sha256===expected.sha256;
try {
  await fs.mkdir(stateRoot,{recursive:true});
  const bucket=proxy.env.NATIVE_DATA,receipt=[];
  for(const object of plan.objects) {
    const existing=await bucket.head(object.key);
    if(existing) {
      if(!same(existing,object))throw new Error('Refusing to overwrite an existing native object with different metadata');
      receipt.push({key:object.key,bytes:existing.size,etag:existing.etag,reused:true});continue;
    }
    const stateFile=path.join(stateRoot,object.sha256+'.json');
    let state;try{state=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(state&&(state.accountId!==target.accountId||state.bucket!==target.bucket||state.key!==object.key||state.bytes!==object.bytes||state.sha256!==object.sha256||state.chunkSize!==chunkSize))throw new Error('Multipart resume state differs from upload target/plan');
    const upload=state?bucket.resumeMultipartUpload(object.key,state.uploadId):await bucket.createMultipartUpload(object.key,{
      httpMetadata:{contentType:object.contentType,cacheControl:'public, max-age=31536000, immutable'},
      customMetadata:{sha256:object.sha256,product:'werhd-vera-native'},
    });
    state??={...deploymentIdentity(target),key:object.key,bytes:object.bytes,sha256:object.sha256,chunkSize,uploadId:upload.uploadId,parts:[]};
    let saving=Promise.resolve();
    const save=()=>{
      const body=JSON.stringify(state,null,2)+'\n';
      saving=saving.then(async()=>{await fs.writeFile(stateFile+'.tmp',body,{mode:0o600});await fs.rename(stateFile+'.tmp',stateFile);});
      return saving;
    };
    await save();
    const total=Math.max(1,Math.ceil(object.bytes/chunkSize)),done=new Set(state.parts.map(part=>part.partNumber));
    const pending=Array.from({length:total},(_,index)=>index+1).filter(part=>!done.has(part));
    const file=await fs.open(object.file,'r');let cursor=0;
    try {
      const workers=await Promise.allSettled(Array.from({length:Math.min(4,pending.length)},async()=>{
        while(cursor<pending.length) {
          const partNumber=pending[cursor++],offset=(partNumber-1)*chunkSize;
          const bytes=Buffer.alloc(Math.min(chunkSize,object.bytes-offset));
          if((await file.read(bytes,0,bytes.length,offset)).bytesRead!==bytes.length)throw new Error('Short local object read');
          let part;
          for(let attempt=0;attempt<3;attempt++) {
            try{part=await upload.uploadPart(partNumber,bytes);break;}
            catch(error){if(attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));}
          }
          if(part.etag.replaceAll('"','')!==md5(bytes))throw new Error('Uploaded part checksum mismatch');
          state.parts.push({partNumber:part.partNumber,etag:part.etag});await save();
        }
      }));
      const failed=workers.filter(worker=>worker.status==='rejected');
      if(failed.length)throw new AggregateError(failed.map(worker=>worker.reason),'Upload interrupted; verified parts retained for resume');
    }finally{await file.close();}
    if(state.parts.length!==total||await hashNativeFile(object.file)!==object.sha256)throw new Error('Object changed during upload; refusing multipart completion');
    const raced=await bucket.head(object.key);
    if(raced){if(!same(raced,object))throw new Error('Refusing to replace an object created concurrently');await upload.abort();receipt.push({key:object.key,bytes:raced.size,etag:raced.etag,reused:true});continue;}
    const parts=state.parts.sort((a,b)=>a.partNumber-b.partNumber);
    const expected=md5(Buffer.concat(parts.map(part=>Buffer.from(part.etag.replaceAll('"',''),'hex'))))+'-'+total;
    await upload.complete(parts);
    const actual=await bucket.head(object.key);
    if(!same(actual,object)||actual.etag.replaceAll('"','')!==expected)throw new Error('Completed object checksum or metadata mismatch');
    receipt.push({key:object.key,bytes:actual.size,etag:actual.etag,reused:false});
    console.log(JSON.stringify({uploaded:true,key:object.key,bytes:actual.size}));
  }
  await fs.writeFile(path.join(directory,'generated/upload-receipt.json'),JSON.stringify({schema:1,...deploymentIdentity(target),profile,releaseSha256:plan.releaseSha256,objects:receipt},null,2)+'\n');
}finally{await proxy.dispose();}
});
