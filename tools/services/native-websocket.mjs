import {WebSocketServer,WebSocket} from 'ws';
import {NativeRoomCoordinator} from './native-room-coordinator.mjs';
import {NATIVE_ROOM_SHARDS,nativeRoomCoordinatorOptions,parseNativeRoomShard} from './native-room-routing.mjs';

export function attachNativeMultiplayer(server,{path='/ws/native',allowedOrigins,loadingTimeoutMs,turnTimeoutMs,messageDelayMs=0}={}) {
  if(!Number.isInteger(messageDelayMs)||messageDelayMs<0||messageDelayMs>1000)throw new Error('Invalid diagnostic message delay');
  const coordinators=new Map([null,...Array.from({length:NATIVE_ROOM_SHARDS},(_,index)=>index)]
    .map(shard=>[shard,new NativeRoomCoordinator({loadingTimeoutMs,turnTimeoutMs,...nativeRoomCoordinatorOptions(shard)})]));
  const coordinator=coordinators.get(null);
  const sockets=new Set();
  const wss=new WebSocketServer({noServer:true,maxPayload:262144});
  const allowed=new Set(allowedOrigins??['http://127.0.0.1:5280','http://localhost:5280']);
  const upgrade=(request,socket,head)=>{
    let url;try{url=new URL(request.url,'http://localhost');}catch{socket.destroy();return;}
    if(url.pathname!==path||!allowed.has(request.headers.origin)){socket.destroy();return;}
    let shard;try{shard=parseNativeRoomShard(url);}catch{
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;
    }
    wss.handleUpgrade(request,socket,head,ws=>wss.emit('connection',ws,coordinators.get(shard)));
  };
  server.on('upgrade',upgrade);
  wss.on('connection',(ws,roomCoordinator)=>{
    sockets.add(ws);let client;
    const guarded=(callback,operation)=>{try{operation();}catch(error){roomCoordinator.handleInternalError(client,error,callback);}};
    // Local diagnostic port only: delay each direction without changing the
    // coordinator or native simulation. Constant delay preserves WS ordering.
    const pending=new Set();
    const deliver=callback=>{
      if(ws.readyState!==WebSocket.OPEN)return;
      if(!messageDelayMs){callback();return;}
      if(pending.size>=512){ws.close(1009,'Diagnostic queue overflow');return;}
      const timer=setTimeout(()=>{pending.delete(timer);if(ws.readyState===WebSocket.OPEN)guarded('message',callback);},messageDelayMs);
      pending.add(timer);
    };
    // Capacity rejection also closes a socket, before it has a coordinator
    // client. Register teardown first so retrying another shard leaks no socket.
    ws.on('error',()=>guarded('error',()=>{if(client)roomCoordinator.disconnect(client);}));
    ws.on('close',()=>guarded('close',()=>{for(const timer of pending)clearTimeout(timer);pending.clear();sockets.delete(ws);if(client)roomCoordinator.disconnect(client);}));
    try{client=roomCoordinator.connect({send:message=>deliver(()=>ws.send(message)),close:(code=1000,reason='Server stopped')=>ws.close(code,reason)});}
    catch(error){if(error?.code==='CLIENT_CAPACITY')ws.close(1013,error.message);else{roomCoordinator.handleInternalError(client,error,'connect');ws.close(1011,'Internal server error');}return;}
    let alive=true;
    ws.on('pong',()=>guarded('heartbeat',()=>{alive=true;roomCoordinator.markClientActive(client);}));
    ws.on('message',(bytes,binary)=>guarded('message',()=>{if(binary){ws.close(1003,'JSON required');return;}const text=bytes.toString();deliver(()=>roomCoordinator.receive(client,text));}));
    ws.nativeHeartbeat=()=>guarded('heartbeat',()=>{if(!alive)ws.terminate();else{alive=false;ws.ping();}});
  });
  const heartbeat=setInterval(()=>{
    for(const value of coordinators.values())try{value.expireIdleClients();}catch(error){value.reportInternalError(error,'heartbeat');}
    for(const ws of sockets)ws.nativeHeartbeat?.();
  },15000);heartbeat.unref();
  let closing;
  return {coordinator,coordinators,wss,allowOrigin(origin){
    const url=new URL(origin);if(!['http:','https:'].includes(url.protocol)||url.origin!==origin)throw new Error('An exact HTTP origin is required');allowed.add(origin);
  },close(){return closing??=(async()=>{server.off('upgrade',upgrade);clearInterval(heartbeat);for(const value of coordinators.values())value.close();for(const ws of sockets)ws.terminate();await new Promise(resolve=>wss.close(resolve));})();}};
}
