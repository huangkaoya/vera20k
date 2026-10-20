import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const lock=JSON.parse(await readFile(path.join(root,'upstream.lock.json'),'utf8'));
const pin=lock.sources.vera20k;
const sourcePath='src/sim/pathfinding/zone_build.rs';
// git show reads the pinned source object; no upstream checkout or index writes.
const upstream=spawnSync('git',['-C',pin.source,'show',`${pin.revision}:${sourcePath}`],{encoding:'utf8',maxBuffer:4*1024*1024});
assert.equal(upstream.status,0,upstream.stderr||'pinned upstream source unavailable');
const original=upstream.stdout;
const current=await readFile(path.join(root,'vendor/vera20k',sourcePath),'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
assert.equal(sha(original),pin.files[sourcePath].sha256,'upstream source differs from pinned manifest');
assert.equal((original.match(/let child_advance = flood_fill_node_index\(/g)??[]).length,2,'pinned baseline must contain the original recursion');
function extract(source,name){
 const start=source.indexOf(`fn ${name}(`);
 assert.ok(start>=0,`missing ${name}`);
 const end=source.indexOf('\n}\n',start);
 assert.ok(end>start,`missing end of ${name}`);
 return source.slice(start,end+3);
}
function module(name,source){
 const fill=extract(source,'flood_fill_node_index').replace('fn flood_fill_node_index(','pub(super) fn flood_fill_node_index(');
 const helpers=['base_record_index','base_level_at','register_scanline_edge'].map(name=>extract(source,name)).join('\n');
 return `mod ${name} {\nuse super::*;\n${fill}\n${helpers}\n}\n`;
}
const common=String.raw`mod zone_class { pub const IMPASSABLE: u8 = 6; }
type ZoneId=u16;
const ZONE_INVALID:u16=0;
#[derive(Default,Debug,PartialEq,Eq)]
struct BaseEdgeBuckets { events: Vec<(u16,u16)> }
impl BaseEdgeBuckets {fn register(&mut self,a:u16,b:u16){self.events.push((a,b));}}
`;
const main=String.raw`fn main(){
 let mut rng=0x5eed_u64;
 fn rand(r:&mut u64)->u32{*r=r.wrapping_mul(6364136223846793005).wrapping_add(1);(*r>>32)as u32}
 for case in 0..20_000 {
  let width=(rand(&mut rng)%12+1)as u16;let height=(rand(&mut rng)%12+1)as u16;
  let len=width as usize*height as usize;
  let classes:Vec<u8>=(0..len).map(|_|(rand(&mut rng)%8)as u8).collect();
  let levels:Vec<u8>=(0..len).map(|_|(rand(&mut rng)%8)as u8).collect();
  let mut a:Vec<u16>=(0..len).map(|_| match rand(&mut rng)%5{0=>2,1=>3,_=>0}).collect();let mut b=a.clone();
  let x=(rand(&mut rng)%width as u32)as u16;let y=(rand(&mut rng)%height as u32)as u16;
  let mut ae=BaseEdgeBuckets::default();let mut be=BaseEdgeBuckets::default();
  let ar=recursive::flood_fill_node_index(x,y,1,&classes,&mut a,&levels,width,height,&mut ae);
  let br=iterative::flood_fill_node_index(x,y,1,&classes,&mut b,&levels,width,height,&mut be);
  assert_eq!((ar,a,ae),(br,b,be),"seeded case {case}, {width}x{height}, seed {x},{y}");
 }
 let n=30_000;let mut ids=vec![0;n];let mut edges=BaseEdgeBuckets::default();
 let advance=iterative::flood_fill_node_index(0,0,1,&vec![0;n],&mut ids,&vec![0;n],1,n as u16,&mut edges);
 assert_eq!(advance,0);assert!(ids.iter().all(|&id|id==1));assert!(edges.events.is_empty());
 println!("PASS: 20,000 recursive/iterative seeded exact return+node IDs+ordered edge-event comparisons; iterative 30,000-row connected component");
}
`;
const buildDir=path.join(root,'.build');
await mkdir(buildDir,{recursive:true});
const harness=path.join(buildDir,'zone-fill-equivalence.rs');
const binary=path.join(buildDir,'zone-fill-equivalence');
await writeFile(harness,common+module('recursive',original)+module('iterative',current)+main);
const compile=spawnSync('rustc',['--edition','2024',harness,'-O','-o',binary],{cwd:root,stdio:'inherit'});
assert.equal(compile.status,0,'zone-fill harness compilation failed');
const test=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:60_000});
process.stdout.write(test.stdout??'');process.stderr.write(test.stderr??'');
assert.equal(test.status,0,'zone-fill equivalence failed');
await mkdir(path.join(root,'validation'),{recursive:true});
await writeFile(path.join(root,'validation/zone-fill-equivalence.json'),JSON.stringify({schema:1,completed:new Date().toISOString(),upstreamRevision:pin.revision,sourcePath,upstreamSha256:sha(original),currentSha256:sha(current),cases:20000,seed:'0x5eed',orderedEdgeEvents:true,connectedRows:30000,result:'passed'},null,2)+'\n');
