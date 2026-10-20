import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.resolve(root,process.argv[2]??'public/generated');
const manifest=JSON.parse(readFileSync(path.join(directory,'catalog.json'),'utf8'));
const pngCache=new Map();
function png(url){
  assert.equal(typeof url,'string','asset URL must be a string');
  assert.ok(url.startsWith('/generated/'),'asset must be generated locally: '+url);
  const file=path.resolve(directory,url.slice('/generated/'.length));
  assert.ok(file.startsWith(directory+path.sep),'asset escapes generated directory');
  if(pngCache.has(file))return pngCache.get(file);
  assert.ok(statSync(file).isFile(),'missing art file '+url);
  const bytes=readFileSync(file);
  assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10],'invalid PNG '+url);
  const size={width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  assert.ok(size.width>0&&size.height>0,'empty image '+url);
  pngCache.set(file,size);return size;
}
assert.equal(manifest.schema,1);
assert.ok(manifest.maps.length>=2,'at least two actual maps must be exported');
assert.equal(JSON.stringify(JSON.parse(readFileSync(path.join(directory,'manifest.json'),'utf8'))),JSON.stringify(manifest),'manifest aliases diverged');
for(const map of manifest.maps){
  const size=png(map.image);png(map.minimap);
  assert.equal(size.width,map.width);assert.equal(size.height,map.height);
  assert.ok(map.cells.length>0,'map needs real terrain cells');
  assert.ok(map.starts.length>=2,'map needs at least two real player starts');
  assert.ok(map.starts.length<=8);
  assert.equal(new Set(map.starts.map(s=>s.index)).size,map.starts.length);
  assert.ok(Number.isFinite(map.originX)&&Number.isFinite(map.originY));
}
const required=['AMCV','SMCV','PCV','GACNST','NACNST','YACNST','GAPOWR','NAPOWR','YAPOWR','GAPILE','NAHAND','YABRCK','GAREFN','NAREFN','YAREFN','GAWEAP','NAWEAP','YAWEAP','MTNK','HTNK','LTNK','E1','E2','INIT','TESLA'];
for(const id of required){
  assert.ok(manifest.sprites[id],'missing starting/production retail graphic '+id);
  assert.ok(typeof manifest.names?.[id]==='string'&&manifest.names[id].length>0,'missing localized retail UIName '+id);
}
let frameCount=0;
for(const [id,sprite]of Object.entries(manifest.sprites)){
  const image=png(sprite.image),mask=png(sprite.remapImage);
  if(sprite.cameo)png(sprite.cameo);
  assert.equal(image.width,sprite.width,id+' image width metadata');
  assert.equal(image.height,sprite.height,id+' image height metadata');
  assert.deepEqual(mask,image,id+' remap atlas must align exactly');
  assert.ok(sprite.frames.length>0,id+' has no decoded frames');
  assert.ok(sprite.source.length>0,id+' lacks original source identity');
  for(const frame of sprite.frames){
    assert.ok(frame.width>0&&frame.height>0,id+' has empty frame');
    assert.ok(frame.x>=0&&frame.y>=0&&frame.x+frame.width<=image.width&&frame.y+frame.height<=image.height,id+' frame cropped by atlas packing');
    assert.ok(Number.isFinite(frame.offsetX)&&Number.isFinite(frame.offsetY),id+' lacks real frame anchor');
    frameCount++;
  }
}
for(const id of ['AMCV','SMCV','PCV','MTNK','HTNK','LTNK'])assert.equal(new Set(manifest.sprites[id].frames.map(f=>f.facing)).size,32,id+' needs all 32 voxel facings');
for(const id of ['E1','E2','INIT'])assert.ok(manifest.sprites[id].frames.some(f=>f.animation===1),id+' needs actual ART walking sequence');
assert.equal(manifest.colors.length,8,'native lobby color priorities');
for(let index=0;index<8;index++){
  const color=manifest.colors.find(c=>c.id===index);assert.ok(color,'missing native color '+index);
  assert.equal(color.ramp.length,16,'native remap shade count');
  for(const rgb of color.ramp)assert.ok(rgb.length===3&&rgb.every(n=>Number.isInteger(n)&&n>=0&&n<=255),'invalid native palette entry');
}
console.log(`[assets] ${manifest.maps.length} maps, ${Object.keys(manifest.sprites).length} sprite types, ${frameCount} frames, ${pngCache.size} PNG files and 8 native 16-shade ramps passed.`);
console.log(`[assets] ${manifest.warnings.length} unavailable unused retail art entries remain listed in catalog warnings.`);
