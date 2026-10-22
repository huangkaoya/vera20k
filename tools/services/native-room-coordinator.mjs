// VERA-native protocol v3: bounded ahead-of-time inputs and independent CRCs. This module has no Node imports so the same room /
// lockstep authority can be hosted locally and in a web runtime.
import {nativeInternalErrorDetails} from './native-room-diagnostics.mjs';
export const NATIVE_PROTOCOL = 3;
export const INPUT_DELAY_TICKS = 8;
const CHECKSUM = /^retail:\d+:[a-f0-9]{8}$/;
const COUNTRIES = new Set(['America','Korea','France','Germany','GreatBritain','Libya','Iraq','Cuba','Russia','Yuri']);
const OPTIONS = Object.freeze({credits:10000,unitCount:10,gameSpeed:3,shortGame:true,superWeapons:true,crates:true,mcvRepacks:true,buildOffAlly:false,destroyableBridges:true});
const clone = value => JSON.parse(JSON.stringify(value));
const ensure = (condition,message,code) => {if(!condition)throw Object.assign(new Error(message),code?{code}:{});};
const integer = (value,min,max,label) => {ensure(Number.isSafeInteger(value)&&value>=min&&value<=max,`无效的${label}`);return value;};
const cleanName = value => typeof value==='string'&&value.trim()?value.trim().slice(0,24):'指挥官';
function roomName(value,members) {
  const base=cleanName(value),used=new Set(members.map(member=>member.name.toLowerCase()));
  let name=base,index=2;
  while(used.has(name.toLowerCase()))name=`${base.slice(0,20)} ${index++}`;
  return name;
}
const hash = value => typeof value==='string'&&/^[a-z0-9:_-]{1,160}$/i.test(value);
function randomCode(prefix) {
  const hex=Array.from(crypto.getRandomValues(new Uint8Array(3)),x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();
  return prefix===null?hex:prefix+hex.slice(0,5);
}
function retireRoom(service,room,reason,force=false) {
  if(!room||room.phase==='stopped'&&!force)return;
  room.phase='stopped';clearTimeout(room.timer);service.rooms.delete(room.code);
  const members=[...room.members];room.members=[];
  for(const member of members){member.room=null;member.ready=false;}
  for(const member of members){
    service.send(member,{type:'stopped',matchId:room.matchId??null,reason});service.send(member,{type:'room',room:null});
  }
  room.frames.clear();room.loaded.clear();room.finished?.clear();room.checksums?.clear();
}
function configFor(value,members) {
  ensure(!value||(typeof value==='object'&&!Array.isArray(value)),'无效的房间设置');
  value??={};
  const map=String(value.map??'XMP29U2.MAP').toUpperCase();
  ensure(map==='XMP29U2.MAP','当前联机版本支持火线冲突（2）');
  const options={...OPTIONS,...value.options};
  integer(options.credits,0,100000,'初始资金');integer(options.unitCount,0,100,'部队数');integer(options.gameSpeed,0,6,'游戏速度');
  for(const key of Object.keys(OPTIONS).filter(key=>typeof OPTIONS[key]==='boolean'))ensure(typeof options[key]==='boolean',`无效的${key}`);
  for(const key of Object.keys(options))ensure(Object.hasOwn(OPTIONS,key),'不支持的游戏选项');
  ensure(value.players===undefined||(Array.isArray(value.players)&&value.players.length<=2),'无效的玩家设置');
  const players=[0,1].map(slot=>{
    const raw=value.players?.find?.(entry=>entry.slot===slot)??{};
    const country=raw.country??(slot===0?'America':'Russia');ensure(COUNTRIES.has(country),'不支持的国家');
    return {slot,name:members.find(member=>member.slot===slot)?.name??`指挥官 ${slot+1}`,country,
      color:integer(raw.color??slot,0,7,'颜色'),start:integer(raw.start??slot,-1,1,'起始位置'),
      team:integer(raw.team??-1,-1,3,'小队'),human:true,difficulty:'normal'};
  });
  const assigned=new Set(players.filter(player=>player.start>=0).map(player=>player.start));
  for(const player of players)if(player.start===-1){player.start=[0,1].find(start=>!assigned.has(start));assigned.add(player.start);}
  ensure(players[0].color!==players[1].color,'两位玩家请选择不同颜色');
  ensure(players[0].start!==players[1].start,'两位玩家不能使用相同起始位置');
  return {seed:integer(value.seed??crypto.getRandomValues(new Uint32Array(1))[0],0,0xffffffff,'随机种子'),map,players,options};
}

export class NativeRoomCoordinator {
  constructor({loadingTimeoutMs=300000,turnTimeoutMs=30000,maxClients=64,maxRooms=32,codePrefix=null,onClientCountChanged=(_count)=>{}}={}) {
    ensure(codePrefix===null||typeof codePrefix==='string'&&/^S[0-7]$/.test(codePrefix),'Invalid native room code prefix');
    ensure(typeof onClientCountChanged==='function','Invalid native client count callback');
    this.rooms=new Map();this.clients=new Set();this.loadingTimeoutMs=loadingTimeoutMs;this.turnTimeoutMs=turnTimeoutMs;
    this.maxClients=maxClients;this.maxRooms=maxRooms;this.codePrefix=codePrefix;this.onClientCountChanged=onClientCountChanged;
  }
  connect({send,close}) {
    ensure(this.clients.size<this.maxClients,'当前服务器人数已满','CLIENT_CAPACITY');
    const client={id:crypto.randomUUID(),send,close,room:null,name:'指挥官',slot:0,ready:false,protocol:null,lastSeenAt:Date.now()};
    this.clients.add(client);this.notifyClientCountChanged(client);
    if(this.clients.has(client))this.send(client,{type:'hello',protocol:NATIVE_PROTOCOL,playerId:client.id});return client;
  }
  notifyClientCountChanged(client) {try{this.onClientCountChanged(this.clients.size);}catch(error){this.handleInternalError(client,error,'client-count');}}
  markClientActive(client,now=Date.now()) {if(this.clients.has(client)&&Number.isFinite(now))client.lastSeenAt=now;}
  reportInternalError(error,callback) {
    try{console.error(JSON.stringify(nativeInternalErrorDetails(error,callback)));}catch{}
  }
  handleInternalError(client,error,callback,room=client?.room) {
    this.reportInternalError(error,callback);
    try{if(room)retireRoom(this,room,'服务器内部错误，对战已停止。',true);}catch(cleanupError){this.reportInternalError(cleanupError,'internal-cleanup');}
    try{if(client)this.disconnect(client);}catch(cleanupError){this.reportInternalError(cleanupError,'internal-cleanup');}
    try{client?.close(1011,'Internal server error');}catch(cleanupError){this.reportInternalError(cleanupError,'internal-cleanup');}
  }
  expireIdleClients({now=Date.now(),idleMs=45000}={}) {
    ensure(Number.isFinite(now)&&Number.isFinite(idleMs)&&idleMs>0,'Invalid native idle deadline');
    let expired=0;
    for(const client of [...this.clients])if(now-client.lastSeenAt>=idleMs){
      expired++;
      try{this.disconnect(client);}catch(error){this.handleInternalError(client,error,'watchdog');continue;}
      try{client.close(1001,'Idle connection expired');}catch(error){this.reportInternalError(error,'idle-close');}
    }
    return expired;
  }
  send(client,message) {try{client.send(JSON.stringify(message));}catch{this.disconnect(client);}}
  broadcast(room,message) {for(const member of [...room.members])this.send(member,message);}
  view(room,client) {
    return {code:room.code,isHost:room.host===client.id,localMemberId:client.id,phase:room.phase,
      members:room.members.map(member=>({id:member.id,name:member.name,slot:member.slot,ready:member.ready,host:member.id===room.host})),
      canStart:room.phase==='lobby'&&room.members.length===2&&room.members.every(member=>member.id===room.host||member.ready),
      config:clone(room.config),status:room.phase==='lobby'?'分享房间号，等待另一位指挥官加入。':room.phase==='loading'?'正在同步战场部署…':'对战进行中'};
  }
  update(room) {for(const member of [...room.members])this.send(member,{type:'room',room:this.view(room,member)});}
  arm(room,ms,reason) {clearTimeout(room.timer);room.timer=setTimeout(()=>{try{this.stop(room,reason);}catch(error){this.handleInternalError(room.members[0],error,'room-timer',room);}},ms);room.timer.unref?.();}
  stop(room,reason) {retireRoom(this,room,reason);}
  leave(client) {
    const room=client.room;if(!room)return;
    const player=room.order?.indexOf(client),receipt=room.finished?.get(player);
    if(room.phase==='finishing'&&receipt){
      // Continue/connection teardown may precede the other native result owner.
      // Keep the authenticated receipt and fixed player order, but detach this
      // client so completing the old match cannot overwrite a newer room.
      room.members=room.members.filter(member=>member!==client);
      client.completedMatchId=room.matchId;client.completedReceipt={...receipt};
      client.room=null;client.ready=false;this.send(client,{type:'room',room:null});return;
    }
    if(room.phase!=='lobby'||room.host===client.id){this.stop(room,room.phase==='lobby'?'房主已离开房间。':'有玩家离开，对战已停止。');return;}
    room.members=room.members.filter(member=>member!==client);client.room=null;client.ready=false;
    for(const member of room.members)member.ready=member.id===room.host;
    room.config=configFor(room.config,room.members);this.update(room);this.send(client,{type:'room',room:null});
  }
  disconnect(client) {if(!this.clients.delete(client))return;try{this.leave(client);}finally{this.notifyClientCountChanged(client);}}
  requireRoom(client,phase,matchId) {
    const room=client.room;ensure(room,'请先加入房间');
    if(phase)ensure(room.phase===phase,'当前房间状态不允许此操作');
    if(matchId!==undefined)ensure(matchId===room.matchId,'对战会话不匹配');return room;
  }
  receive(client,text) {
    if(!this.clients.has(client))return;
    try {
      ensure(typeof text==='string'&&text.length<=262144,'房间消息过大');
      const message=JSON.parse(text);ensure(message&&typeof message.type==='string','无效的房间消息');
      if(message.type==='hello')ensure(message.protocol===NATIVE_PROTOCOL,'联机协议不匹配，请更新客户端');
      else ensure(client.protocol===NATIVE_PROTOCOL,'联机协议不匹配，请更新客户端');
      this.markClientActive(client);
      // Output already in flight when both native result owners completed is
      // harmless. A finished socket cannot author another world frame.
      if(client.completedMatchId===message.matchId&&['input','checksum','finished','chat','taunt'].includes(message.type)){
        if(message.type==='finished')ensure(message.tick===client.completedReceipt?.tick&&message.checksum===client.completedReceipt?.checksum,'重复结束对局内容不一致');
        return;
      }
      switch(message.type) {
        case 'hello': {
          ensure(message.protocol===NATIVE_PROTOCOL,'联机协议不匹配，请更新客户端');client.protocol=NATIVE_PROTOCOL;
          // Connection identity is assigned by the server. The browser ID is
          // advisory only and never supplies player/command authority.
          break;
        }
        case 'ping':this.send(client,{type:'pong'});break;
        case 'create': {
          ensure(!client.room,'请先离开当前房间');ensure(this.rooms.size<this.maxRooms,'服务器房间已满','ROOM_CAPACITY');
          client.name=cleanName(message.name);client.slot=0;client.ready=true;
          let code;do{code=randomCode(this.codePrefix);}while(this.rooms.has(code));
          const room={code,host:client.id,members:[client],phase:'lobby',config:null,frames:new Map(),loaded:new Map(),progress:new Map(),timer:null};
          room.config=configFor(message.config,room.members);client.room=room;this.rooms.set(code,room);this.update(room);break;
        }
        case 'join': {
          ensure(!client.room,'请先离开当前房间');const code=String(message.code??'').trim().toUpperCase();
          ensure(/^(?:[A-F0-9]{6}|S[0-7][A-F0-9]{5})$/.test(code),'无效的房间号');const room=this.rooms.get(code);
          ensure(room?.phase==='lobby','找不到可加入的房间');ensure(room.members.length<2,'房间已满');
          client.name=roomName(message.name,room.members);client.slot=1;client.ready=false;client.room=room;room.members.push(client);
          room.config=configFor(room.config,room.members);this.update(room);break;
        }
        case 'config': {
          const room=this.requireRoom(client,'lobby');ensure(room.host===client.id,'只有房主可以修改规则');
          room.config=configFor(message.config,room.members);for(const member of room.members)member.ready=member.id===room.host;this.update(room);break;
        }
        case 'ready': {
          const room=this.requireRoom(client,'lobby');ensure(room.host!==client.id,'房主无需切换准备状态');client.ready=!client.ready;this.update(room);break;
        }
        case 'start': {
          const room=this.requireRoom(client,'lobby');ensure(room.host===client.id,'只有房主可以开始');ensure(this.view(room,client).canStart,'请等待所有玩家准备');
          room.phase='loading';room.matchId=crypto.randomUUID();room.order=[...room.members].sort((a,b)=>a.slot-b.slot);room.tick=0;
          room.frames.clear();room.loaded.clear();room.progress.clear();room.finished=new Map();room.checksums=new Map();room.committed=[];room.submitted=[];this.arm(room,this.loadingTimeoutMs,'等待战场部署超时，对战已停止。');
          this.update(room);room.order.forEach((member,playerIndex)=>this.send(member,{type:'start',matchId:room.matchId,playerIndex,config:clone(room.config)}));break;
        }
        case 'progress': {
          const room=this.requireRoom(client,'loading',message.matchId),source=room.order.indexOf(client);
          const percent=integer(message.percent,0,100,'载入进度');ensure(percent>=(room.progress.get(source)??0),'载入进度不能倒退');
          room.progress.set(source,percent);this.broadcast(room,{type:'progress',matchId:room.matchId,source,percent});break;
        }
        case 'loaded': {
          const room=this.requireRoom(client,'loading',message.matchId),player=room.order.indexOf(client);
          ensure(message.protocol===NATIVE_PROTOCOL,'联机协议不匹配，请更新客户端');
          ensure(!room.loaded.has(player),'重复提交战场状态');integer(message.tick,0,Number.MAX_SAFE_INTEGER-1,'作战帧');
          ensure(hash(message.hash),'无效的状态校验');ensure(Array.isArray(message.owners)&&message.owners.length===2&&new Set(message.owners).size===2,'无效的玩家映射');
          message.owners.forEach(owner=>integer(owner,0,0xffffffff,'玩家身份'));ensure(typeof message.build==='string'&&message.build.length>0&&message.build.length<=512,'缺少客户端版本');
          ensure([...room.progress.values()].length===2&&[...room.progress.values()].every(percent=>percent===100),'请等待全部玩家完成载入');
          ensure(typeof message.resourceManifest==='string'&&/^[a-f0-9]{64}$/i.test(message.resourceManifest),'缺少资源完整性标识');
          room.loaded.set(player,{tick:message.tick,hash:message.hash,owners:message.owners,build:message.build,resourceManifest:message.resourceManifest});
          if(room.loaded.size===2){
            const a=room.loaded.get(0),b=room.loaded.get(1);
            // Full saves contain local-view state (PlayerPtr outcome, discovery,
            // radar). Preserve each hash for diagnosis; native Queue_AI supplies
            // the actual shared checksum on the first ordinary committed frame.
            const shared=({hash,...receipt})=>receipt;
            if(JSON.stringify(shared(a))!==JSON.stringify(shared(b))){this.stop(room,'初始帧、玩家映射、游戏资源或客户端版本不一致，对战已停止。');break;}
            room.owners=a.owners;room.initialTick=a.tick;room.tick=a.tick+1;room.phase='running';
            room.committed=[a.tick,a.tick];room.submitted=[a.tick,a.tick];
            this.broadcast(room,{type:'ready',matchId:room.matchId,tick:room.tick,bootstrap:room.matchId,protocol:NATIVE_PROTOCOL,inputDelayTicks:INPUT_DELAY_TICKS});
            this.arm(room,this.turnTimeoutMs,'等待玩家指令超时，对战已停止。');
          }break;
        }
        case 'input': {
          const room=this.requireRoom(client,undefined,message.matchId),player=room.order.indexOf(client);
          if(room.phase==='finishing')break;
          ensure(room.phase==='running','当前房间状态不允许作战指令');
          ensure(!Object.hasOwn(message,'prevHash'),'旧版逐帧校验协议不受支持');
          const tick=integer(message.tick,room.initialTick+1,Number.MAX_SAFE_INTEGER-1,'作战帧');
          ensure(tick===room.submitted[player]+1,'作战帧顺序不正确或重复提交');
          // The window is tied to executed receipts, not to the broadcast
          // frontier: a client cannot manufacture unbounded future turns by
          // exchanging empty inputs without actually advancing its world.
          ensure(tick<=room.committed[player]+INPUT_DELAY_TICKS,'作战帧超出提前输入窗口');
          ensure(Array.isArray(message.commands)&&message.commands.length<=256,'每帧最多提交256条指令');
          const commands=message.commands.map(envelope=>{
            ensure(envelope&&typeof envelope==='object'&&!Array.isArray(envelope),'无效的原生指令');
            ensure(envelope.owner===room.owners[player],'禁止提交其他玩家的指令');
            ensure(envelope.execute_tick===tick,'指令执行帧不匹配');
            const payload=envelope.payload,keys=payload&&typeof payload==='object'&&!Array.isArray(payload)?Object.keys(payload):[];
            ensure(typeof payload==='string'?/^[A-Z][A-Za-z0-9]*$/.test(payload):keys.length===1&&/^[A-Z][A-Za-z0-9]*$/.test(keys[0]),'无效的指令内容');
            ensure(payload!=='Select'&&!Object.hasOwn(Object(payload),'Select'),'本地选择不能作为联网指令');
            return {player,envelope:clone(envelope)};
          });
          let frame=room.frames.get(tick);
          if(!frame){frame=new Map();room.frames.set(tick,frame);}
          ensure(!frame.has(player),'重复提交当前作战帧');
          frame.set(player,commands);room.submitted[player]=tick;
          this.drainTurns(room);break;
        }
        case 'checksum': {
          const room=this.requireRoom(client,undefined,message.matchId),player=room.order.indexOf(client);
          ensure(room.phase==='running'||room.phase==='finishing','当前房间状态不能提交帧校验');
          if(room.phase==='finishing'&&message.tick>room.terminalTick)break;
          const tick=integer(message.tick,room.initialTick+1,Number.MAX_SAFE_INTEGER-1,'校验帧');
          ensure(tick===room.committed[player]+1,'校验帧顺序不正确或重复提交');
          ensure(tick<room.tick,'不能校验尚未广播的作战帧');
          ensure(tick<=room.committed[1-player]+INPUT_DELAY_TICKS,'校验帧超出另一位玩家的执行窗口');
          ensure(typeof message.checksum==='string'&&CHECKSUM.test(message.checksum),'缺少原生逐帧校验凭据');
          let frame=room.checksums.get(tick);
          if(!frame){frame=new Map();room.checksums.set(tick,frame);}
          frame.set(player,message.checksum);room.committed[player]=tick;
          if(frame.size===2){
            if(frame.get(0)!==frame.get(1)){this.stop(room,`第${tick}帧状态校验不一致，对战已停止。`);break;}
            room.checksums.delete(tick);
          }break;
        }
        case 'finished': {
          const room=this.requireRoom(client,undefined,message.matchId),player=room.order.indexOf(client);
          ensure(room.phase==='running'||room.phase==='finishing','当前房间状态不能结束对局');
          const tick=integer(message.tick,room.initialTick+1,Number.MAX_SAFE_INTEGER-1,'结束帧');
          ensure(tick===room.committed[player]&&room.tick-tick>=1&&room.tick-tick<=INPUT_DELAY_TICKS+1,'结束帧不属于当前已执行作战回合');
          ensure(typeof message.checksum==='string'&&CHECKSUM.test(message.checksum),'缺少原生结束校验');
          const previous=room.finished.get(player);
          if(previous){ensure(previous.tick===tick&&previous.checksum===message.checksum,'重复结束对局内容不一致');break;}
          room.finished.set(player,{tick,checksum:message.checksum});room.terminalTick??=tick;room.phase='finishing';room.frames.clear();
          if(room.finished.size===2){
            const a=room.finished.get(0),b=room.finished.get(1);
            if(JSON.stringify(a)!==JSON.stringify(b)){this.stop(room,'双方对局结束帧或原生校验不一致。');break;}
            clearTimeout(room.timer);room.phase='finished';this.rooms.delete(room.code);
            for(const member of [...room.members]){
              if(member.room!==room)continue;
              member.completedMatchId=room.matchId;member.completedReceipt={...a};member.room=null;member.ready=false;
              this.send(member,{type:'finished',matchId:room.matchId,...a});this.send(member,{type:'room',room:null});
            }
            room.members=[];room.finished.clear();room.loaded.clear();room.checksums.clear();
          }else this.arm(room,this.turnTimeoutMs,'等待另一位玩家确认对局结束超时。');
          break;
        }
        case 'chat':
        case 'taunt': {
          const room=this.requireRoom(client,undefined,message.matchId),source=room.order.indexOf(client);
          if(room.phase==='finishing')break;
          ensure(room.phase==='running','当前房间状态不允许聊天');
          ensure(Array.isArray(message.recipients)&&message.recipients.length<=2,'无效的消息接收者');
          const recipients=[...new Set(message.recipients)];recipients.forEach(index=>integer(index,0,room.order.length-1,'消息接收者'));
          const payload=message.type==='chat'
            ?{text:(ensure(typeof message.text==='string'&&message.text.length>0&&message.text.length<=512,'聊天文字过长或为空'),message.text)}
            :{byte:integer(message.byte,0,255,'嘲讽语音')};
          for(const index of recipients)this.send(room.order[index],{type:message.type,matchId:room.matchId,source,...payload});break;
        }
        case 'leave':this.leave(client);break;
        default:throw new Error('不支持的原生联机消息');
      }
    }catch(error){this.send(client,{type:'error',error:error instanceof Error?error.message:String(error),
      ...(error?.code==='ROOM_CAPACITY'?{code:'ROOM_CAPACITY'}:{})});}
  }
  drainTurns(room) {
    if(room.draining)return;
    room.draining=true;
    try {
      while(room.phase==='running'&&room.frames.get(room.tick)?.size===2){
        const tick=room.tick,frame=room.frames.get(tick);
        room.frames.delete(tick);room.tick++;
        this.broadcast(room,{type:'turn',matchId:room.matchId,tick,commands:[...frame.get(0),...frame.get(1)]});
        if(room.phase==='running')this.arm(room,this.turnTimeoutMs,'等待玩家指令超时，对战已停止。');
      }
    } finally {room.draining=false;}
  }
  close() {for(const room of [...this.rooms.values()])this.stop(room,'服务器已停止。');for(const client of [...this.clients]){this.disconnect(client);try{client.close();}catch{}}}
}
