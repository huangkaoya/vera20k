import { GameUI } from './ui/GameUI';
import type { SkirmishConfig, UiCommand, ProductionCategory, BattleHudState } from './ui/types';
import { BattlefieldRenderer } from './render/BattlefieldRenderer';
import type { AssetsManifest } from './render/types';
import { VeraEngine } from './engine/VeraEngine';
import { engineConfig } from './engine/config';
import type { Snapshot, VeraCommand } from './engine/types';

let manifest: AssetsManifest;
let engine: VeraEngine | undefined;
let renderer: BattlefieldRenderer | undefined;
let snapshot: Snapshot | undefined;
let selected: number[] = [];
let pending: VeraCommand[] = [];
let placementType: string | undefined;
let placementSequence = 0;
let placing = false;
let attackMove = false;
let generation = 0;
let running = false;
let paused = false;
let stepTimer = 0;
let renderFrame = 0;
let lastMini = 0;
let frameInterval = 66;
let message = '';
const keys = new Set<string>();
const hashTrace = new Map<number,string>();
// Room transport is attached below; single-player never opens a socket.
let roomTick: ((state: Snapshot) => void) | undefined;
let leaveRoom: (() => void) | undefined;

const ui = new GameUI(document.querySelector<HTMLElement>('#app')!, {
  onStart: config => start(config), onCommand: command => issue(command),
  onLeaveBattle: () => leave(),
  onCreateRoom: config => createRoom(config), onJoinRoom: code => joinRoom(code),
  onLeaveRoom: () => disconnectRoom(), onRoomConfigChange: config => {void room?.setConfig(config).catch(error=>ui.notify(String(error),true));},
  onToggleReady: () => {void room?.toggleReady().catch(error=>ui.notify(String(error),true));}, onStartRoom: () => {void room?.start().catch(error=>ui.notify(String(error),true));},
});

function fail(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  console.error(error); running = false; clearTimeout(stepTimer);
  message = `引擎已停止：${text}`; updateHud(); ui.notify(message, true);
}
function enqueue(command: VeraCommand): void {
  if (!running || !snapshot) return;
  pending.push({...command, player:snapshot.viewPlayer});
}
function ownIds(): number[] {
  return selected.filter(id => snapshot?.entities.some(e => e.id === id && e.owner === snapshot!.localOwner && !e.limbo && e.alive !== false));
}
function select(ids: number[], additive = false): void {
  selected = [...new Set(additive ? [...selected, ...ids] : ids)];
  renderer?.setSelection(selected); updateHud();
}
function updateHud(): void {
  if (!snapshot) return;
  const me = snapshot.players.find(p => p.owner === snapshot!.localOwner);
  selected = selected.filter(id => snapshot!.entities.some(e => e.id === id && !e.limbo && e.alive !== false && e.hp > 0));
  const entities = snapshot.entities.filter(e => selected.includes(e.id));
  const entity = entities[0];
  const names: Record<string,string> = {AMCV:'盟军基地车',SMCV:'苏军基地车',PCV:'尤里基地车',GACNST:'盟军建造厂',NACNST:'苏军建造厂',YACNST:'尤里建造厂'};
  const category = (native: string): ProductionCategory => native === 'building' ? 'building' : native === 'defense' || native === 'combat' ? 'defense' : native === 'infantry' ? 'infantry' : 'vehicle';
  const hud: BattleHudState = {
    tick:snapshot.tick,elapsedSeconds:snapshot.tick * snapshot.tickMs / 1000,credits:me?.credits ?? 0,
    power:{output:me?.power ?? 0,drain:me?.drain ?? 0},paused,
    faction:me?.country === 'Yuri' ? 'yuri' : ['Russia','Iraq','Cuba','Libya'].includes(me?.country ?? '') ? 'soviet' : 'allied',
    selected:entity ? {ids:selected,name:entities.length > 1 ? `${entities.length} 个单位` : manifest.names?.[entity.typeId] ?? names[entity.typeId] ?? entity.typeId,typeId:entity.typeId,
      cameo:manifest.sprites[entity.typeId]?.cameo,ownerName:snapshot.players.find(p => p.owner === entity.owner)?.name,
      hp:entities.reduce((sum,e) => sum+e.hp,0),maxHp:entities.reduce((sum,e) => sum+e.maxHp,0),
      canDeploy:['AMCV','SMCV','PCV'].includes(entity.typeId),canSell:entity.category === 'structure'} : null,
    production:snapshot.buildOptions.map(option => ({typeId:option.typeId,name:manifest.names?.[option.typeId] ?? option.displayName,cost:option.cost,category:category(option.category),
      cameo:manifest.sprites[option.typeId]?.cameo,available:option.enabled,reason:option.reason ?? undefined})),
    queues:[...snapshot.queues.map(q => ({typeId:q.typeId,progress:q.total ? q.progress/q.total : 0,paused:q.state === 'paused',ready:snapshot!.ready.some(r=>r.typeId===q.typeId)})),
      ...snapshot.ready.filter(r=>!snapshot!.queues.some(q=>q.typeId===r.typeId)).map(q => ({typeId:q.typeId,progress:1,ready:true}))],
    message:message || (placementType ? '选择绿色区域部署建筑；右键取消。' : attackMove ? '选择攻击移动的目标位置。' : me?.defeated ? '你的阵营已战败。' : ''),
  };
  ui.setBattleState(hud); renderer?.setSelection(selected);
}
function accept(next: Snapshot): void {
  snapshot=next; renderer?.setSnapshot(next);
  hashTrace.set(next.tick,next.stateHash);
  if(hashTrace.size>1000)hashTrace.delete(hashTrace.keys().next().value!);
  ui.canvas.dataset.tick=String(next.tick); ui.canvas.dataset.stateHash=next.stateHash;
  ui.canvas.dataset.owner=String(next.localOwner); ui.canvas.dataset.entityCount=String(next.entities.length);
  updateHud();
}
async function start(config: SkirmishConfig, viewPlayer = 0, multiplayer = false): Promise<void> {
  leave(false); const token = ++generation;
  frameInterval=[16,33,50,66,83,100,125][config.gameSpeed] ?? 66;
  ui.showLoading('正在准备 VERA WASM 引擎…',0); message='';
  const next = new VeraEngine((text,progress) => {if(token === generation)ui.setLoadProgress(text,progress);}); engine=next;
  try {
    const state = await next.init(engineConfig(config,viewPlayer)); if(token !== generation)return;
    ui.showBattle(); renderer = new BattlefieldRenderer(ui.canvas,manifest); renderer.setMap(config.mapId);
    await renderer.load(); if(token !== generation)return;
    accept(state);
    const home=state.entities.find(e => e.owner===state.localOwner && !e.limbo && ['AMCV','SMCV','PCV'].includes(e.typeId));
    if(home)renderer.centerOnWorld(home.sx,home.sy);
    running=true; paused=false; keys.clear(); draw();
    if(multiplayer)room?.loaded(state.stateHash,state.tick); else schedule();
  } catch(error) {if(token===generation){fail(error);next.dispose();if(multiplayer)disconnectRoom();ui.showLobby();}}
}
function leave(showLobby = true): void {
  generation++; running=false; clearTimeout(stepTimer); cancelAnimationFrame(renderFrame); keys.clear();
  engine?.dispose(); engine=undefined; renderer=undefined; snapshot=undefined; selected=[];pending=[];
  hashTrace.clear();
  placementType=undefined; placementSequence++; placing=false;attackMove=false;message='';
  if(showLobby){leaveRoom?.();ui.showLobby();}
}
function schedule(): void {
  if(!running || roomTick)return;
  stepTimer=window.setTimeout(async () => {
    if(!running || !engine)return;
    const token=generation,current=engine;
    try {
      if(!paused){const next=await current.step(pending.splice(0));if(token!==generation || current!==engine)return;accept(next);}
      if(token===generation)schedule();
    }catch(error){if(token===generation && current===engine)fail(error);}
  },frameInterval);
}
function draw(): void {
  if(!running || !renderer)return;
  const dx=(Number(keys.has('ArrowRight'))-Number(keys.has('ArrowLeft')))*12;
  const dy=(Number(keys.has('ArrowDown'))-Number(keys.has('ArrowUp')))*12;
  if(dx||dy)renderer.panBy(dx,dy);
  renderer.render();
  if(performance.now()-lastMini>180){renderer.drawMinimap(ui.minimap);lastMini=performance.now();}
  renderFrame=requestAnimationFrame(draw);
}
function issue(command: UiCommand): void {
  if(!snapshot || !running)return;
  message='';
  switch(command.type){
    case 'produce': for(let i=0;i<Math.min(20,command.count);i++)enqueue({kind:'produce',typeId:command.typeId});break;
    case 'cancelProduction': enqueue({kind:'cancelProduction',typeId:command.typeId});break;
    case 'place':placementType=command.typeId;attackMove=false;renderer?.setPlacement(null);break;
    case 'pause':if(roomTick){ui.notify('联机对局使用同步时钟。');return;}paused=command.paused;break;
    case 'attackMove':attackMove=true;placementType=undefined;renderer?.setPlacement(null);break;
    default:{const ids=ownIds();if(ids.length)enqueue({kind:command.type,entityIds:ids});break;}
  }
  updateHud();
}

let pointer: {x:number;y:number;button:number;shift:boolean;lastX:number;lastY:number} | undefined;
ui.canvas.addEventListener('contextmenu',event=>event.preventDefault());
ui.canvas.addEventListener('pointerdown',event=>{
  if(!running)return;event.preventDefault();ui.canvas.setPointerCapture(event.pointerId);
  pointer={x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,button:event.button,shift:event.shiftKey};
});
ui.canvas.addEventListener('pointermove',event=>{
  if(!running || !renderer)return;
  if(pointer?.button===1){renderer.panBy(pointer.lastX-event.clientX,pointer.lastY-event.clientY);pointer.lastX=event.clientX;pointer.lastY=event.clientY;}
  else if(pointer?.button===0 && !placementType)renderer.setSelectionRect({x1:pointer.x,y1:pointer.y,x2:event.clientX,y2:event.clientY});
  if(placementType && !placing && engine){
    const cell=renderer.screenToCell(event.clientX,event.clientY),typeId=placementType,token=++placementSequence,match=generation,current=engine;placing=true;
    void current.placement(typeId,cell.rx,cell.ry).then(p=>{if(match===generation && token===placementSequence && placementType===typeId)renderer?.setPlacement({typeId,...cell,valid:p.valid});}).catch(error=>{if(match===generation)fail(error);}).finally(()=>{if(match===generation)placing=false;});
  }
});
ui.canvas.addEventListener('pointerup',event=>{
  if(!running || !renderer || !snapshot || !pointer)return;
  const p=pointer;pointer=undefined;renderer.setSelectionRect(undefined);
  const cell=renderer.screenToCell(event.clientX,event.clientY);
  if(p.button===2){
    if(placementType || attackMove){placementType=undefined;attackMove=false;placementSequence++;renderer.setPlacement(null);updateHud();return;}
    order(cell.rx,cell.ry,renderer.hitTest(event.clientX,event.clientY)?.id);return;
  }
  if(p.button!==0)return;
  if(placementType && engine){
    const typeId=placementType,token=generation,current=engine;void current.placement(typeId,cell.rx,cell.ry).then(result=>{
      if(token!==generation || current!==engine || placementType!==typeId)return;
      if(result.valid){enqueue({kind:'place',typeId,...cell});placementType=undefined;placementSequence++;renderer?.setPlacement(null);updateHud();}
      else ui.notify(`此处不能建造：${result.reason ?? '超出建造范围或地形受阻'}`);
    }).catch(error=>{if(token===generation)fail(error);});return;
  }
  if(attackMove){order(cell.rx,cell.ry);attackMove=false;updateHud();return;}
  if(Math.hypot(event.clientX-p.x,event.clientY-p.y)>5){select(renderer.entitiesInRect(p.x,p.y,event.clientX,event.clientY).filter(e=>e.owner===snapshot!.localOwner).map(e=>e.id),p.shift);return;}
  const entity=renderer.hitTest(event.clientX,event.clientY);select(entity ? [entity.id] : [],p.shift);
});
function order(rx:number,ry:number,targetId?:number):void {
  const ids=ownIds();if(!ids.length || !snapshot)return;
  const target=snapshot.entities.find(e=>e.id===targetId);
  const attack=target && target.owner!==snapshot.localOwner;
  enqueue(attack?{kind:'attack',entityIds:ids,targetId}:{kind:attackMove?'attackMove':'move',entityIds:ids,rx,ry});
  renderer?.flashOrder(rx,ry,!!attack||attackMove);
}
ui.canvas.addEventListener('dblclick',event=>{
  const entity=renderer?.hitTest(event.clientX,event.clientY);
  if(entity && entity.owner===snapshot?.localOwner && ['AMCV','SMCV','PCV'].includes(entity.typeId))enqueue({kind:'deploy',entityId:entity.id});
});
ui.canvas.addEventListener('wheel',event=>{if(!running)return;event.preventDefault();renderer?.zoomAt(Math.exp(-event.deltaY*.001),event.clientX,event.clientY);},{passive:false});
ui.minimap.addEventListener('pointerdown',event=>{const point=renderer?.minimapToWorld(ui.minimap,event.clientX,event.clientY);if(point)renderer?.centerOnWorld(point.x,point.y);});
window.addEventListener('keydown',event=>{
  if(!running || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)return;
  if(event.key.startsWith('Arrow')){event.preventDefault();keys.add(event.key);return;}
  if(event.repeat)return;
  const type=({a:'attackMove',s:'stop',g:'guard',d:'deploy',x:'scatter'} as const)[event.key.toLowerCase() as 'a'];
  if(type){event.preventDefault();issue({type,ids:selected});}
  if(event.key==='Escape'){placementType=undefined;attackMove=false;placementSequence++;renderer?.setPlacement(null);updateHud();}
});
window.addEventListener('keyup',event=>keys.delete(event.key));window.addEventListener('blur',()=>keys.clear());

// Read-only diagnostics used by local acceptance and useful when reporting a failure.
Object.defineProperty(window,'__veraWeb',{value:Object.freeze({
  get state(){return snapshot;}, get running(){return running;}, get selected(){return [...selected];},
  get missingSprites(){return [...renderer?.uncoveredTypes ?? []];},get engine(){return 'VERA Rust WASM';},
  get hashTrace(){return [...hashTrace].map(([tick,hash])=>({tick,hash}));},
})});

// Local lockstep transport is intentionally separate from the WERHD production services.
import { RoomClient } from './network/RoomClient';
let room: RoomClient | undefined;
async function connectRoom():Promise<RoomClient>{
  if(room){await room.connect();return room;}
  const client=new RoomClient({
    onRoom:state=>ui.setRoom(state), onError:error=>{ui.notify(error,true);if(running)fail(error);},
    onStart:async({config,playerIndex})=>{roomTick=()=>{};await start(config,playerIndex,true);},
    onTurn:async({tick,commands})=>{
      if(!engine||!snapshot||!running)return;
      const token=generation,current=engine;
      try{
        if(tick!==snapshot.tick+1)throw new Error(`同步帧不连续：${tick}`);
        const next=await current.step(commands);if(token!==generation || current!==engine)return;accept(next);
        stepTimer=window.setTimeout(()=>{if(token===generation&&running&&snapshot)client.submit(snapshot.tick+1,pending.splice(0),snapshot.stateHash);},frameInterval);
      }catch(error){if(token===generation && current===engine){fail(error);void client.leave().catch(()=>{});}}
    },
    onReady:()=>{if(snapshot)client.submit(snapshot.tick+1,pending.splice(0),snapshot.stateHash);},
    onStop:reason=>{
      const wasPlaying=running && !!snapshot;generation++;running=false;clearTimeout(stepTimer);cancelAnimationFrame(renderFrame);
      keys.clear();pending=[];engine?.dispose();engine=undefined;disconnectRoom();
      if(wasPlaying){message=reason;updateHud();renderer?.render();}else{snapshot=undefined;renderer=undefined;ui.showLobby();}
      ui.notify(reason,true);
    },
  });
  room=client;leaveRoom=()=>disconnectRoom();
  try{await client.connect();return client;}catch(error){if(room===client)disconnectRoom();throw error;}
}
async function createRoom(config:SkirmishConfig){try{await(await connectRoom()).create(config);}catch(error){ui.notify(String(error),true);}}
async function joinRoom(code:string){try{await(await connectRoom()).join(code,ui.getConfig().playerName);}catch(error){ui.notify(String(error),true);}}
function disconnectRoom(){room?.close();room=undefined;roomTick=undefined;leaveRoom=undefined;ui.setRoom(null);}

try {
  manifest=await BattlefieldRenderer.loadManifest('/generated/catalog.json');
  ui.setCatalog({
    maps:manifest.maps.map(map=>({id:map.id,name:map.title,maxPlayers:map.starts.length,previewUrl:map.minimap,size:`${map.localWidth} × ${map.localHeight}`})),
    countries:[['America','美国'],['Korea','韩国'],['France','法国'],['Germany','德国'],['GreatBritain','英国'],['Russia','苏俄'],['Iraq','伊拉克'],['Cuba','古巴'],['Libya','利比亚'],['Yuri','尤里']].map(([id,name])=>({id,name})),
    colors:['黄色','红色','蓝色','绿色','橙色','青色','紫色','粉色'].map((name,id)=>({id,name,hex:['#f3d548','#ed4545','#5086f0','#57b85b','#ed9d43','#58d0ce','#ae68db','#e778bf'][id]})),
  });
} catch(error){ui.notify(`资源尚未准备好：${error instanceof Error?error.message:String(error)}。请运行 npm run build。`,true);}
