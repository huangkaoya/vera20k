import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const retail=process.env.VERA_ASSET_ROOT??path.join(os.homedir(),'Library/Application Support/VERA20k/retail-assets');
const target=path.join(root,'.build/cargo');
const policy=JSON.parse(await readFile(path.join(root,'tools/retail-policy.json'),'utf8'));
const allowed=name=>{const n=name.toLowerCase();return !policy.exclude.includes(n)&&(policy.names.includes(n)||n.endsWith('.mix')&&policy.mixPrefixes.some(p=>n.startsWith(p))||policy.extensions.some(e=>n.endsWith(e)));};
const nativePath=process.env.VERA_NATIVE_ORACLE??path.join(target,'release/vera-web-native');
const receiptName=process.env.VERA_PARITY_RECEIPT??'parity';
assert.match(receiptName,/^[a-zA-Z0-9_-]+$/,'receipt name');
if(!process.argv.includes('--no-build')&&!process.env.VERA_NATIVE_ORACLE){
 const b=spawnSync('cargo',['build','--locked','--release','-p','vera-web-core','--bin','vera-web-native'],{cwd:root,env:{...process.env,CARGO_TARGET_DIR:target},stdio:'inherit'});
 if(b.status!==0)process.exit(b.status??1);
}
const wasmBytes=await readFile(path.join(root,'public/wasm/vera_web_core.wasm'));
const {instance}=await WebAssembly.instantiate(wasmBytes,{});
const e=instance.exports;
for(const name of ['memory','vw_alloc','vw_dealloc','vw_asset','vw_call','vw_result_ptr','vw_result_len'])assert.ok(e[name],`missing ${name}`);
const text=new TextEncoder();const decode=new TextDecoder();
function result(ptr=e.vw_result_ptr()){return JSON.parse(decode.decode(new Uint8Array(e.memory.buffer,ptr,e.vw_result_len())));}
function alloc(bytes){const p=e.vw_alloc(bytes.length);new Uint8Array(e.memory.buffer,p,bytes.length).set(bytes);return p;}
function wasmCall(request){const bytes=text.encode(JSON.stringify(request));const p=alloc(bytes);try{return result(e.vw_call(p,bytes.length));}finally{e.vw_dealloc(p,bytes.length);}}
let assetBytes=0;const registered=[];
for(const entry of (await readdir(retail,{withFileTypes:true})).filter(f=>f.isFile()&&allowed(f.name)).sort((a,b)=>a.name.localeCompare(b.name))){
 const bytes=await readFile(path.join(retail,entry.name));const name=text.encode(entry.name);const np=alloc(name),dp=alloc(bytes);
 const status=e.vw_asset(np,name.length,dp,bytes.length);assert.equal(status,0,JSON.stringify(result()));assetBytes+=bytes.length;registered.push({name:entry.name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
console.log(`Registered ${registered.length} retail files (${Math.round(assetBytes/1024/1024)} MB) in WASM`);
const native=spawn(nativePath,['--assets',retail],{cwd:root,stdio:['pipe','pipe','pipe']});
let stderr='';native.stderr.on('data',chunk=>{stderr+=chunk.toString();});
const lines=readline.createInterface({input:native.stdout})[Symbol.asyncIterator]();
const requests=[],hashes=[],checks=[];let snapshot;let calls=0;
async function call(request,label,expectOk=true){
 requests.push(request);
 const w=wasmCall(request);
 native.stdin.write(JSON.stringify(request)+'\n');
 const next=await lines.next();assert.ok(!next.done,`native oracle exited: ${stderr}`);
 const n=JSON.parse(next.value);
 assert.deepEqual(w.ok,n.ok,`${label}: result status`);
 assert.equal(w.ok,expectOk,`${label}: ${w.error??n.error??'failed'}`);
 if(w.snapshot){
  assert.equal(w.snapshot.tick,n.snapshot.tick,`${label}: tick`);
  if(w.snapshot.stateHash!==n.snapshot.stateHash){
   await mkdir(path.join(root,'validation'),{recursive:true});await writeFile(path.join(root,'validation/native-divergence.json'),JSON.stringify(n));await writeFile(path.join(root,'validation/wasm-divergence.json'),JSON.stringify(w));
   const d={op:'diagnostics',includeSave:true};const wd=wasmCall(d);native.stdin.write(JSON.stringify(d)+'\n');const nd=JSON.parse((await lines.next()).value);
   if(wd.ok&&nd.ok){for(const key of Object.keys(wd.diagnostics.owners)){if(wd.diagnostics.owners[key]!==nd.diagnostics.owners[key])console.error('Divergent owner',key,wd.diagnostics.owners[key],nd.diagnostics.owners[key]);}
    const wb=Buffer.from(wd.diagnostics.save),nb=Buffer.from(nd.diagnostics.save);await writeFile(path.join(root,'validation/wasm-divergence.sav'),wb);await writeFile(path.join(root,'validation/native-divergence.sav'),nb);await writeFile(path.join(root,'validation/hash-diagnostics.json'),JSON.stringify({wasm:{owners:wd.diagnostics.owners,digest:wd.diagnostics.digest},native:{owners:nd.diagnostics.owners,digest:nd.diagnostics.digest}},null,2));
    let first=0;while(first<Math.min(wb.length,nb.length)&&wb[first]===nb[first])first++;console.error('Authoritative save bytes',wb.length,nb.length,'first differing offset',first);
   }else console.error('Diagnostics unavailable',wd.error,nd.error);
  }
  assert.equal(w.snapshot.stateHash,n.snapshot.stateHash,`${label}: native/WASM full state hash at tick ${w.snapshot.tick}`);
  assert.deepEqual(w.snapshot.entities,n.snapshot.entities,`${label}: entity projection`);
  assert.deepEqual(w.snapshot.players,n.snapshot.players,`${label}: houses`);
  snapshot=w.snapshot;
  if(request.op==='tick')hashes.push({tick:snapshot.tick,hash:snapshot.stateHash});
 }else if(w.placement)assert.deepEqual(w.placement,n.placement,`${label}: native placement`);
 calls++;if(calls%250===0)console.log(`Compared ${hashes.length} frames; current tick ${snapshot?.tick} (${label})`);return w;
}
async function tick(commands=[],label='frame'){await call({op:'tick',ticks:1,commands},label);}
async function frames(count,label){for(let i=0;i<count;i++)await tick([],label);}
async function until(predicate,limit,label){for(let i=0;i<limit;i++){if(predicate(snapshot))return i;await tick([],label);}assert.ok(predicate(snapshot),`${label}: unmet after ${limit} frames`);return limit;}
function own(type){return snapshot.entities.filter(x=>x.owner===snapshot.localOwner&&x.alive&&!x.limbo&&(!type||x.typeId===type));}
async function production(type){
 const option=snapshot.buildOptions.find(x=>x.typeId===type&&x.enabled);assert.ok(option,`${type} is a real available production option`);
 const old=own(type).length;await tick([{kind:'queue',typeId:type,player:0}],`queue ${type}`);
 const isBuilding=['building','defense'].includes(option.category);
 await until(s=>isBuilding?s.ready.some(r=>r.typeId===type):own(type).length>old,3000,`complete ${type}`);
 if(!isBuilding){checks.push(`${type} mobile factory delivery`);return;}
 const yard=own('GACNST')[0];assert.ok(yard,'construction yard retained');
 let placed=false;
 const candidates=[];for(let dx=-12;dx<=12;dx++)for(let dy=-12;dy<=12;dy++)candidates.push({rx:yard.rx+dx,ry:yard.ry+dy,d:Math.abs(dx)+Math.abs(dy)});
 candidates.sort((a,b)=>a.d-b.d||a.rx-b.rx||a.ry-b.ry);
 for(const p of candidates){if(p.rx<0||p.ry<0)continue;
  const {placement}=await call({op:'placement',typeId:type,rx:p.rx,ry:p.ry},`preview ${type}`);
  if(placement.valid){await tick([{kind:'place',typeId:type,rx:p.rx,ry:p.ry,player:0}],`place ${type}`);placed=true;break;}
 }
 assert.ok(placed,`${type} has a legal native placement`);
 await until(()=>own(type).length>old,30,`admit ${type}`);await frames(120,`buildup ${type}`);
 checks.push(`${type} production and placement`);
}
const config={map:'XMP29U2.MAP',seed:0x5eed0001,localPlayer:0,viewPlayer:0,players:[
 {slot:0,name:'Player',country:'America',color:0,start:0,team:0,human:true},
 {slot:1,name:'Computer',country:'Russia',color:1,start:1,team:0,human:false,difficulty:'easy'},
],options:{credits:50000,unitCount:8,gameSpeed:4,shortGame:false,superWeapons:true,crates:false,mcvRepacks:true,buildOffAlly:true,destroyableBridges:true,fogOfWar:false,shroud:false}};
const started=new Date().toISOString();
try{
 await call({op:'init',config},'retail initialization');
 assert.ok(snapshot.entities.length>0&&own().length>0,'real retail objects and starting army');
 const mcv=own().find(x=>['AMCV','MCV'].includes(x.typeId));assert.ok(mcv,'American MCV from native skirmish bootstrap');
 const mover=own().find(x=>x.id!==mcv.id&&x.category!=='structure');assert.ok(mover,'starting mobile army');
 const before=[mover.rx,mover.ry,mover.subX,mover.subY];
 await tick([{kind:'move',entityId:mover.id,rx:mover.rx+3,ry:mover.ry+2,player:0}],'move starting unit');await frames(90,'movement');
 const moved=snapshot.entities.find(x=>x.id===mover.id);assert.ok(moved&&JSON.stringify([moved.rx,moved.ry,moved.subX,moved.subY])!==JSON.stringify(before),'native movement changed position');checks.push('real starting unit movement');
 await tick([{kind:'deploy',entityId:mcv.id,player:0}],'MCV deploy');await until(()=>own('GACNST').length>0,240,'construction yard creation');await frames(120,'yard buildup');checks.push('MCV to construction yard');
 await production('GAPOWR');await production('GAPILE');await production('GAREFN');await production('GAWEAP');await production('E1');await production('MTNK');
 await tick([{kind:'queue',typeId:'MTNK',player:0}],'queue cancellation control');
 await tick([{kind:'cancelProduction',typeId:'MTNK',all:true,player:0}],'cancel production');assert.ok(!snapshot.queues.some(q=>q.typeId==='MTNK'),'production cancellation admitted');checks.push('production cancellation');
 const attacker=own('MTNK')[0],victim=own('E1')[0];assert.ok(attacker&&victim,'real combat actors');
 const victimHp=victim.hp;
 await tick([{kind:'attack',entityId:attacker.id,targetId:victim.id,player:0}],'forced target attack');
 await until(s=>{const v=s.entities.find(x=>x.id===victim.id);return !v||v.hp<victimHp;},600,'combat damage');checks.push('real weapon damage');
 const traceEnd=snapshot.tick;
 // Two human clients use one canonical world and independent read-only viewers.
 const networkConfig={...config,players:config.players.map((p,i)=>({...p,human:true,name:`Peer${i+1}`}))};
 await call({op:'init',config:networkConfig},'two human setup');const canonical=snapshot.stateHash;
 await call({op:'snapshot',viewPlayer:1},'switch viewer');assert.equal(snapshot.stateHash,canonical,'viewer changes do not alter authority hash');
 const foreign=snapshot.entities.find(x=>x.owner===snapshot.players.find(p=>p.humanIndex===0).owner&&x.alive&&!x.limbo);assert.ok(foreign,'foreign live actor control');
 await call({op:'tick',commands:[{kind:'move',entityId:foreign.id,rx:foreign.rx+1,ry:foreign.ry+1,player:1}]},'reject foreign actor',false);
 await call({op:'snapshot'},'world after rejected foreign input');assert.equal(snapshot.stateHash,canonical,'rejected input cannot mutate authority');
 await tick([{kind:'move',entityId:9007199250000,rx:10,ry:10,player:1}],'ignore expired actor');checks.push('foreign actor rejected and expired actor harmless');
 const remote=own().find(x=>x.category!=='structure');assert.ok(remote,'second human army');
 await tick([{kind:'move',entityId:remote.id,rx:remote.rx+1,ry:remote.ry+1,player:1}],'second human input');await frames(30,'two human continuation');
 await call({op:'dispose'},'dispose');await call({op:'init',config},'retail re-entry');assert.equal(snapshot.tick,0);checks.push('two human command ownership and independent viewer');checks.push('dispose and real retail re-entry');
 for(const [faction,yardType,mcvType,powerType] of [['Yuri','YACNST','PCV','YAPOWR'],['Russia','NACNST','SMCV','NAPOWR']]){
  const other={...config,map:'XMP03T4.MAP',players:config.players.map((p,i)=>({...p,country:i===0?faction:(faction==='Yuri'?'Russia':'Yuri')}))};
  await call({op:'init',config:other},`second map ${faction}`);const carrier=own(mcvType)[0];assert.ok(carrier,`${faction} real starting MCV`);
  await tick([{kind:'deploy',entityId:carrier.id,player:0}],`${faction} deploy`);await until(()=>own(yardType).length>0,240,`${faction} construction yard`);await frames(120,`${faction} buildup`);
  assert.ok(snapshot.buildOptions.some(o=>o.typeId===powerType&&o.enabled),`${faction} native build catalog`);
  await tick([{kind:'queue',typeId:powerType,player:0}],`${faction} native power production`);await until(s=>s.ready.some(r=>r.typeId===powerType),1200,`${faction} completed building`);
  checks.push(`XMP03T4 ${faction} MCV deployment and native power production`);
 }

 const receipt={schema:1,started,completed:new Date().toISOString(),map:config.map,seed:config.seed,assetPolicy:'tools/retail-policy.json',assetCount:registered.length,assetBytes,assets:registered,nativeOracle:path.relative(root,nativePath),nativeOracleSha256:createHash('sha256').update(await readFile(nativePath)).digest('hex'),wasmSha256:createHash('sha256').update(wasmBytes).digest('hex'),checks,calls,comparedFrames:hashes.length,mainTraceTicks:traceEnd,hashes};
 await mkdir(path.join(root,'validation'),{recursive:true});await writeFile(path.join(root,`validation/${receiptName}.json`),JSON.stringify(receipt,null,2)+'\n');await writeFile(path.join(root,`validation/${receiptName}-requests.json`),JSON.stringify(requests)+'\n');
 console.log(`PASS: ${hashes.length} native/WASM frames, ${checks.length} gameplay checks; validation/${receiptName}.json`);
}catch(error){console.error('Parity failure:',error);console.error(stderr.slice(-4000));await mkdir(path.join(root,'validation'),{recursive:true});await writeFile(path.join(root,'validation/parity-failure.json'),JSON.stringify({error:String(error),calls,tick:snapshot?.tick,lastRequest:requests.at(-1),checks},null,2));process.exitCode=1;
}finally{native.stdin.end();native.kill();}
