/// <reference lib="webworker" />
import type { EngineResult } from './types';
import { resolveHttpUrl, resolveResourceManifest, type RuntimeAssets } from '../config/runtime';

type Exports = {
  memory: WebAssembly.Memory;
  vw_alloc(size:number):number;
  vw_dealloc(ptr:number,size:number):void;
  vw_asset(name:number,nameLen:number,bytes:number,len:number):number;
  vw_call(ptr:number,len:number):number;
  vw_result_ptr():number;
  vw_result_len():number;
};
let api:Exports|null=null;
let phase='初始化';
const encoder=new TextEncoder(), decoder=new TextDecoder();
function result():EngineResult {
  if(!api)throw new Error('Simulation is not loaded');
  return JSON.parse(decoder.decode(new Uint8Array(api.memory.buffer,api.vw_result_ptr(),api.vw_result_len())));
}
function call(request:unknown):EngineResult {
  if(!api)throw new Error('Simulation is not loaded');
  const data=encoder.encode(JSON.stringify(request)), ptr=api.vw_alloc(data.length);
  new Uint8Array(api.memory.buffer,ptr,data.length).set(data);
  try { phase=`执行 ${(request as {op?:string}).op ?? 'request'}`;api.vw_call(ptr,data.length);phase='解析引擎响应';return result(); }
  finally {api.vw_dealloc(ptr,data.length);}
}
async function load(assets:RuntimeAssets,pageUrl:string):Promise<void> {
  if(api)return;
  self.postMessage({type:'progress',message:'正在载入游戏引擎',progress:0});
  const wasmUrl=resolveHttpUrl(assets.wasmUrl,pageUrl,pageUrl);
  const response=await fetch(wasmUrl);
  if(!response.ok)throw new Error(`WASM build missing (${response.status}); run npm run build:wasm`);
  phase='编译 WASM';const module=await WebAssembly.instantiate(await response.arrayBuffer(),{});
  api=module.instance.exports as unknown as Exports;
  const resourceManifestUrl=resolveHttpUrl(assets.resourceManifestUrl,pageUrl,pageUrl);
  const manifestResponse=await fetch(resourceManifestUrl);
  if(!manifestResponse.ok)throw new Error('本地游戏资源不可用，请检查资源目录');
  const manifest=resolveResourceManifest(await manifestResponse.json(),manifestResponse.url || resourceManifestUrl,pageUrl);
  let completed=0;
  for(const file of manifest.files){
    phase=`读取资源 ${file.name}`;
    self.postMessage({type:'progress',message:`正在载入游戏资源 ${Math.round(completed/1024/1024)} / ${Math.round(manifest.totalBytes/1024/1024)} MB`,progress:completed/manifest.totalBytes});
    const response=await fetch(file.url);
    if(!response.ok)throw new Error(`Resource ${file.name}: HTTP ${response.status}`);
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength!==file.bytes)throw new Error(`Resource length mismatch: ${file.name}`);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==file.sha256)throw new Error(`Resource integrity mismatch: ${file.name}`);
    const name=encoder.encode(file.name), namePtr=api.vw_alloc(name.length), dataPtr=api.vw_alloc(bytes.byteLength);
    new Uint8Array(api.memory.buffer,namePtr,name.length).set(name);
    new Uint8Array(api.memory.buffer,dataPtr,bytes.byteLength).set(new Uint8Array(bytes));
    // vw_asset consumes both allocations even when it reports an error.
    if(api.vw_asset(namePtr,name.length,dataPtr,bytes.byteLength)!==0)throw new Error(result().error??'Resource import failed');
    completed+=file.bytes;
  }
  self.postMessage({type:'progress',message:'正在部署战场',progress:1});
}
let queue=Promise.resolve();
self.onmessage=(event:MessageEvent<{id:number;request:unknown;assets:RuntimeAssets;pageUrl:string}>)=>{
  queue=queue.then(async()=>{
    try {
      await load(event.data.assets,event.data.pageUrl);
      const answer=call(event.data.request);
      self.postMessage({id:event.data.id,result:answer});
    } catch(error) {
      console.error(`VERA Worker ${phase}`,error);
      self.postMessage({id:event.data.id,result:{ok:false,error:`${phase}：${error instanceof Error?error.message:String(error)}`,stack:error instanceof Error?error.stack:undefined},fatal:true});
      // A WASM panic/trap invalidates this instance; the owner terminates it.
    }
  });
};
