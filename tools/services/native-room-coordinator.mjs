// VERA-native protocol v2. This module has no Node imports so the same room /
// lockstep authority can be hosted locally and in a web runtime.
const COUNTRIES = new Set(['America','Korea','France','Germany','GreatBritain','Libya','Iraq','Cuba','Russia','Yuri']);
const OPTIONS = Object.freeze({credits:10000,unitCount:10,gameSpeed:3,shortGame:true,superWeapons:true,crates:true,mcvRepacks:true,buildOffAlly:false,destroyableBridges:true});
const clone = value => JSON.parse(JSON.stringify(value));
const ensure = (condition,message) => {if(!condition)throw new Error(message);};
const integer = (value,min,max,label) => {ensure(Number.isSafeInteger(value)&&value>=min&&value<=max,`无效的${label}`);return value;};
const cleanName = value => typeof value==='string'&&value.trim()?value.trim().slice(0,24):'指挥官';
function roomName(value,members) {
  const base=cleanName(value),used=new Set(members.map(member=>member.name.toLowerCase()));
  let name=base,index=2;
  while(used.has(name.toLowerCase()))name=`${base.slice(0,20)} ${index++}`;
  return name;
}
const hash = value => typeof value==='string'&&/^[a-z0-9:_-]{1,160}$/i.test(value);
function randomCode() {return Array.from(crypto.getRandomValues(new Uint8Array(3)),x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();}
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
  constructor({loadingTimeoutMs=300000,turnTimeoutMs=30000,maxClients=64,maxRooms=32}={}) {
    this.rooms=new Map();this.clients=new Set();this.loadingTimeoutMs=loadingTimeoutMs;this.turnTimeoutMs=turnTimeoutMs;
    this.maxClients=maxClients;this.maxRooms=maxRooms;
  }
  connect({send,close}) {
    ensure(this.clients.size<this.maxClients,'当前服务器人数已满');
    const client={id:crypto.randomUUID(),send,close,room:null,name:'指挥官',slot:0,ready:false};
    this.clients.add(client);this.send(client,{type:'hello',protocol:2,playerId:client.id});return client;
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
  arm(room,ms,reason) {clearTimeout(room.timer);room.timer=setTimeout(()=>this.stop(room,reason),ms);room.timer.unref?.();}
  stop(room,reason) {
    if(room.phase==='stopped')return;
    room.phase='stopped';clearTimeout(room.timer);this.rooms.delete(room.code);
    for(const member of [...room.members]){
      member.room=null;member.ready=false;this.send(member,{type:'stopped',matchId:room.matchId??null,reason});this.send(member,{type:'room',room:null});
    }
    room.members=[];room.frames.clear();room.loaded.clear();room.finished?.clear();
  }
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
  disconnect(client) {if(!this.clients.delete(client))return;this.leave(client);}
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
      // Output already in flight when both native result owners completed is
      // harmless. A finished socket cannot author another world frame.
      if(client.completedMatchId===message.matchId&&['input','finished','chat','taunt'].includes(message.type)){
        if(message.type==='finished')ensure(message.tick===client.completedReceipt?.tick&&message.checksum===client.completedReceipt?.checksum,'重复结束对局内容不一致');
        return;
      }
      switch(message.type) {
        case 'hello': {
          ensure(message.protocol===2,'联机协议不匹配，请更新客户端');
          // Connection identity is assigned by the server. The browser ID is
          // advisory only and never supplies player/command authority.
          break;
        }
        case 'create': {
          ensure(!client.room,'请先离开当前房间');ensure(this.rooms.size<this.maxRooms,'服务器房间已满');
          client.name=cleanName(message.name);client.slot=0;client.ready=true;
          let code;do{code=randomCode();}while(this.rooms.has(code));
          const room={code,host:client.id,members:[client],phase:'lobby',config:null,frames:new Map(),loaded:new Map(),progress:new Map(),timer:null};
          room.config=configFor(message.config,room.members);client.room=room;this.rooms.set(code,room);this.update(room);break;
        }
        case 'join': {
          ensure(!client.room,'请先离开当前房间');const room=this.rooms.get(String(message.code??'').trim().toUpperCase());
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
          room.frames.clear();room.loaded.clear();room.progress.clear();room.finished=new Map();this.arm(room,this.loadingTimeoutMs,'等待战场部署超时，对战已停止。');
          this.update(room);room.order.forEach((member,playerIndex)=>this.send(member,{type:'start',matchId:room.matchId,playerIndex,config:clone(room.config)}));break;
        }
        case 'progress': {
          const room=this.requireRoom(client,'loading',message.matchId),source=room.order.indexOf(client);
          const percent=integer(message.percent,0,100,'载入进度');ensure(percent>=(room.progress.get(source)??0),'载入进度不能倒退');
          room.progress.set(source,percent);this.broadcast(room,{type:'progress',matchId:room.matchId,source,percent});break;
        }
        case 'loaded': {
          const room=this.requireRoom(client,'loading',message.matchId),player=room.order.indexOf(client);
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
            this.broadcast(room,{type:'ready',matchId:room.matchId,tick:room.tick,bootstrap:room.matchId});
            this.arm(room,this.turnTimeoutMs,'等待玩家指令超时，对战已停止。');
          }break;
        }
        case 'input': {
          const room=this.requireRoom(client,undefined,message.matchId),player=room.order.indexOf(client);
          if(room.phase==='finishing')break;
          ensure(room.phase==='running','当前房间状态不允许作战指令');
          ensure(message.tick===room.tick,'作战帧顺序不正确');ensure(hash(message.prevHash),'无效的状态校验');ensure(!room.frames.has(player),'重复提交当前作战帧');
          if(room.tick===room.initialTick+1)ensure(message.prevHash===`launch:${room.matchId}`,'初始装载凭据不匹配');
          else ensure(/^retail:\d+:[a-f0-9]{8}$/.test(message.prevHash),'缺少原生逐帧校验凭据');
          ensure(Array.isArray(message.commands)&&message.commands.length<=256,'每帧最多提交256条指令');
          const commands=message.commands.map(envelope=>{
            ensure(envelope&&typeof envelope==='object'&&!Array.isArray(envelope),'无效的原生指令');
            ensure(envelope.owner===room.owners[player],'禁止提交其他玩家的指令');
            ensure(envelope.execute_tick===room.tick,'指令执行帧不匹配');
            const payload=envelope.payload,keys=payload&&typeof payload==='object'&&!Array.isArray(payload)?Object.keys(payload):[];
            ensure(typeof payload==='string'?/^[A-Z][A-Za-z0-9]*$/.test(payload):keys.length===1&&/^[A-Z][A-Za-z0-9]*$/.test(keys[0]),'无效的指令内容');
            ensure(payload!=='Select'&&!Object.hasOwn(Object(payload),'Select'),'本地选择不能作为联网指令');
            return {player,envelope:clone(envelope)};
          });
          room.frames.set(player,{hash:message.prevHash,commands});
          if(room.frames.size===2){
            const a=room.frames.get(0),b=room.frames.get(1);
            if(a.hash!==b.hash){this.stop(room,`第${room.tick}帧状态校验不一致，对战已停止。`);break;}
            const turn={type:'turn',matchId:room.matchId,tick:room.tick,commands:[...a.commands,...b.commands]};
            room.tick++;room.frames.clear();this.broadcast(room,turn);this.arm(room,this.turnTimeoutMs,'等待玩家指令超时，对战已停止。');
          }break;
        }
        case 'finished': {
          const room=this.requireRoom(client,undefined,message.matchId),player=room.order.indexOf(client);
          ensure(room.phase==='running'||room.phase==='finishing','当前房间状态不能结束对局');
          const tick=integer(message.tick,room.initialTick+1,Number.MAX_SAFE_INTEGER-1,'结束帧');
          ensure(room.tick-tick>=1&&room.tick-tick<=2,'结束帧不属于当前作战回合');
          ensure(typeof message.checksum==='string'&&/^retail:\d+:[a-f0-9]{8}$/.test(message.checksum),'缺少原生结束校验');
          const previous=room.finished.get(player);
          if(previous){ensure(previous.tick===tick&&previous.checksum===message.checksum,'重复结束对局内容不一致');break;}
          room.finished.set(player,{tick,checksum:message.checksum});room.phase='finishing';room.frames.clear();
          if(room.finished.size===2){
            const a=room.finished.get(0),b=room.finished.get(1);
            if(JSON.stringify(a)!==JSON.stringify(b)){this.stop(room,'双方对局结束帧或原生校验不一致。');break;}
            clearTimeout(room.timer);room.phase='finished';this.rooms.delete(room.code);
            for(const member of [...room.members]){
              if(member.room!==room)continue;
              member.completedMatchId=room.matchId;member.completedReceipt={...a};member.room=null;member.ready=false;
              this.send(member,{type:'finished',matchId:room.matchId,...a});this.send(member,{type:'room',room:null});
            }
            room.members=[];room.finished.clear();room.loaded.clear();
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
    }catch(error){this.send(client,{type:'error',error:error instanceof Error?error.message:String(error)});}
  }
  close() {for(const room of [...this.rooms.values()])this.stop(room,'服务器已停止。');for(const client of [...this.clients]){try{client.close();}catch{}this.clients.delete(client);}}
}
