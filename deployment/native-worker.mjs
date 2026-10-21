import {DurableObject} from 'cloudflare:workers';
import {NativeRoomCoordinator} from '../tools/services/native-room-coordinator.mjs';
import release from './generated/release.json';

const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const sameOrigin=request=>request.headers.get('Origin')===new URL(request.url).origin;
const methodAllowed=request=>request.method==='GET'||request.method==='HEAD';

function selectedRange(header,size) {
  if(!header)return null;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!match||(!match[1]&&!match[2])||size===0)return false;
  let start,end;
  if(!match[1]) {
    const suffix=Number(match[2]);
    if(!Number.isSafeInteger(suffix)||suffix<=0)return false;
    start=Math.max(0,size-suffix);end=size-1;
  } else {
    start=Number(match[1]);end=match[2]?Number(match[2]):size-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return false;
    end=Math.min(end,size-1);
  }
  return {offset:start,length:end-start+1};
}

/** @param {Request} request @param {Env} env @param {{key:string,bytes:number,sha256:string,contentType:string}} entry */
async function objectResponse(request,env,entry) {
  const url=new URL(request.url),etag=`"${entry.sha256}"`;
  if(url.searchParams.has('sha256')&&url.searchParams.get('sha256')!==entry.sha256)return json({error:'Resource version unavailable'},404);
  const headers=new Headers({'Content-Type':entry.contentType,'ETag':etag,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff',
    'Cache-Control':url.searchParams.get('sha256')===entry.sha256?'public, max-age=31536000, immutable, no-transform':'public, max-age=0, must-revalidate, no-transform'});
  const conditional=request.headers.get('If-None-Match');
  if(conditional?.split(',').map(value=>value.trim()).some(value=>value===etag||value==='*'))return new Response(null,{status:304,headers});
  const rangeHeader=request.headers.get('If-Range')&&request.headers.get('If-Range')!==etag?null:request.headers.get('Range');
  const range=selectedRange(rangeHeader,entry.bytes);
  if(range===false){headers.set('Content-Range',`bytes */${entry.bytes}`);return new Response(null,{status:416,headers});}
  const loaded=request.method==='HEAD'
    ?{object:await env.NATIVE_DATA.head(entry.key),body:null}
    :await env.NATIVE_DATA.get(entry.key,range?{range}:undefined).then(object=>({object,body:object?.body??null}));
  const object=loaded.object;
  if(!object||object.size!==entry.bytes||object.customMetadata?.sha256!==entry.sha256)return json({error:'Release resource unavailable or metadata mismatch'},503);
  const length=range?.length??entry.bytes;
  headers.set('Content-Length',String(length));
  if(range)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${entry.bytes}`);
  if(request.method==='HEAD')return new Response(null,{status:range?206:200,headers});
  return new Response(loaded.body,{status:range?206:200,headers});
}

/** @extends {DurableObject<Env>} */
export class NativeRooms extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.coordinator=new NativeRoomCoordinator();
  }
  async fetch(request) {
    if(!sameOrigin(request))return json({error:'Origin rejected'},403);
    if(request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket upgrade required'},426);
    const [clientSocket,serverSocket]=Object.values(new WebSocketPair());
    // Standard WebSocket ownership deliberately pins this instance while a
    // match exists. Node and DO share the same ephemeral coordinator; a host
    // restart closes sessions instead of silently resuming incomplete turns.
    serverSocket.accept();
    let client;
    const disconnect=()=>{if(client)this.coordinator.disconnect(client);};
    serverSocket.addEventListener('message',event=>{
      if(typeof event.data!=='string'||new TextEncoder().encode(event.data).byteLength>262144){disconnect();serverSocket.close(1009,'Message too large');return;}
      this.coordinator.receive(client,event.data);
    });
    serverSocket.addEventListener('close',disconnect);
    serverSocket.addEventListener('error',disconnect);
    try {
      client=this.coordinator.connect({send:text=>serverSocket.send(text),close:()=>serverSocket.close(1001,'Server stopped')});
    } catch {
      serverSocket.close(1013,'Server capacity reached');
    }
    return new Response(null,{status:101,webSocket:clientSocket});
  }
}

/** @satisfies {ExportedHandler<Env>} */
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    try {
      if(url.pathname==='/ws/native') {
        if(!sameOrigin(request))return json({error:'Origin rejected'},403);
        return env.NATIVE_ROOMS.getByName('native-v2').fetch(request);
      }
      if(!methodAllowed(request))return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
      if(url.pathname==='/api/health')return json({ok:true,app:'werhd-vera-native',protocol:2,renderer:'VERA wgpu/WebGPU',patchSha256:release.build.patchSha256,resourceManifestSha256:release.build.resourceManifestSha256});
      if(url.pathname==='/api/native/resources')return request.method==='HEAD'?new Response(null,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}):json(release.resources);
      if(url.pathname==='/native/build.json')return request.method==='HEAD'?new Response(null,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}):json(release.build);
      let pathname;
      try{pathname=decodeURIComponent(url.pathname);}catch{return json({error:'Invalid path'},400);}
      const key=pathname.startsWith('/retail/')?pathname.toLowerCase():pathname;
      const entry=Object.hasOwn(release.objects,key)?release.objects[key]:null;
      if(entry)return objectResponse(request,env,entry);
      // Unlisted retail files and all source/config paths fail closed. ASSETS
      // contains only the intentionally packaged browser entry, JS and fonts.
      if(pathname.startsWith('/retail/')||pathname.endsWith('.wasm')||pathname.startsWith('/api/'))return json({error:'Route not exposed'},404);
      const assetRequest=url.pathname==='/'?new Request(new URL('/index.html',url),request):request;
      const response=await env.ASSETS.fetch(assetRequest);
      const headers=new Headers(response.headers);
      headers.set('X-Content-Type-Options','nosniff');
      headers.set('Cache-Control','public, max-age=0, must-revalidate, no-transform');
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    } catch(error) {
      console.error(JSON.stringify({event:'native-request-failed',path:url.pathname,errorType:error?.name??'Error'}));
      return json({error:'Native service unavailable'},503);
    }
  },
};
