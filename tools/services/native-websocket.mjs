import {WebSocketServer,WebSocket} from 'ws';
import {NativeRoomCoordinator} from './native-room-coordinator.mjs';

export function attachNativeMultiplayer(server,{path='/ws/native',allowedOrigins,loadingTimeoutMs,turnTimeoutMs}={}) {
  const coordinator=new NativeRoomCoordinator({loadingTimeoutMs,turnTimeoutMs});
  const sockets=new Set();
  const wss=new WebSocketServer({noServer:true,maxPayload:262144});
  const allowed=new Set(allowedOrigins??['http://127.0.0.1:5280','http://localhost:5280']);
  const upgrade=(request,socket,head)=>{
    let url;try{url=new URL(request.url,'http://localhost');}catch{socket.destroy();return;}
    if(url.pathname!==path||!allowed.has(request.headers.origin)){socket.destroy();return;}
    wss.handleUpgrade(request,socket,head,ws=>wss.emit('connection',ws));
  };
  server.on('upgrade',upgrade);
  wss.on('connection',ws=>{
    sockets.add(ws);let client;
    try{client=coordinator.connect({send:message=>{if(ws.readyState===WebSocket.OPEN)ws.send(message);},close:()=>ws.close(1000,'Server stopped')});}
    catch(error){ws.close(1013,error.message);return;}
    let alive=true;
    ws.on('pong',()=>{alive=true;});ws.on('error',()=>{});
    ws.on('message',(bytes,binary)=>{if(binary){ws.close(1003,'JSON required');return;}coordinator.receive(client,bytes.toString());});
    ws.on('close',()=>{sockets.delete(ws);coordinator.disconnect(client);});
    ws.nativeHeartbeat=()=>{if(!alive)ws.terminate();else{alive=false;ws.ping();}};
  });
  const heartbeat=setInterval(()=>{for(const ws of sockets)ws.nativeHeartbeat?.();},15000);heartbeat.unref();
  let closing;
  return {coordinator,wss,allowOrigin(origin){
    const url=new URL(origin);if(!['http:','https:'].includes(url.protocol)||url.origin!==origin)throw new Error('An exact HTTP origin is required');allowed.add(origin);
  },close(){return closing??=(async()=>{server.off('upgrade',upgrade);clearInterval(heartbeat);coordinator.close();for(const ws of sockets)ws.terminate();await new Promise(resolve=>wss.close(resolve));})();}};
}
