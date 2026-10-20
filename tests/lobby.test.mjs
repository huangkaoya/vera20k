import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
mkdirSync('.build/tests',{recursive:true});
await build({entryPoints:['web/src/lobby/model.test.ts'],outfile:'.build/tests/lobby-model.mjs',bundle:true,platform:'node',format:'esm'});
await import(pathToFileURL(process.cwd()+'/.build/tests/lobby-model.mjs').href);
await build({entryPoints:['web/src/engine/config.ts'],outfile:'.build/tests/engine-config.mjs',bundle:true,platform:'node',format:'esm'});
const {engineConfig}=await import(pathToFileURL(process.cwd()+'/.build/tests/engine-config.mjs').href);
const config={mapId:'XMP29U2.MAP',seed:123,playerName:'甲',localHouse:0,credits:10000,unitCount:0,gameSpeed:3,shortGame:true,superWeapons:true,mcvRepacks:true,cratesAppear:false,buildOffAlly:true,
 slots:[{id:0,kind:'human',country:'America',color:-2,start:-2,team:-2,difficulty:'normal'},
 {id:1,kind:'human',name:'乙',country:'Yuri',color:2,start:1,team:0,difficulty:'normal'}]};
test('peers resolve random colors identically and reserve fixed colors',()=>{
 const a=engineConfig(config,0),b=engineConfig(config,1);
 assert.deepEqual(a.players,b.players);assert.equal(a.localPlayer,b.localPlayer);
 assert.notEqual(a.viewPlayer,b.viewPlayer);assert.notEqual(a.players[0].color,2);
 assert.equal(a.players[0].start,-1);assert.equal(a.players[1].team,1);
 assert.equal(a.players[0].team,0);assert.equal(a.players[0].name,'甲');assert.equal(a.players[1].name,'乙');
 const oldRoom=structuredClone(config);oldRoom.slots[1].kind='ai';oldRoom.slots[1].name='上次房间玩家';
 assert.equal(engineConfig(oldRoom).players[1].name,'电脑 2');
});
