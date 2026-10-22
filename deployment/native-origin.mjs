// Toy hosts the browser entry while this Worker retains the immutable catalog,
// assets and multiplayer service. Admit only the user's requested HTTPS domain;
// this does not change any bucket CORS policy or use browser credentials.
export function nativeRequestOrigin(request) {
  const origin=request.headers.get('Origin');
  if(!origin||origin==='null')return null;
  let source;
  try{source=new URL(origin);}catch{return null;}
  // An Origin is a scheme/authority, never a URL with credentials, path, query
  // or fragment. Accept explicit HTTPS port 443 as the same default port.
  if(source.username||source.password||source.pathname!=='/'||source.search||source.hash||
    (source.origin!==origin&&!(source.protocol==='https:'&&origin===`${source.origin}:443`)))return null;
  if(source.origin===new URL(request.url).origin)return origin;
  const toyHost=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*bilibilitoy\.com$/;
  return source.protocol==='https:'&&!source.port&&source.hostname.length<=253&&toyHost.test(source.hostname)?origin:null;
}

function vary(headers,names) {
  const values=(headers.get('Vary')??'').split(',').map(value=>value.trim()).filter(Boolean);
  for(const name of names)if(!values.some(value=>value.toLowerCase()===name.toLowerCase()))values.push(name);
  headers.set('Vary',values.join(', '));
}

export function nativeCorsResponse(request,response) {
  // WebSocket upgrades retain their original socket-bearing response. Their
  // Origin is checked before both the Worker route and Durable Object accept.
  if(response.status===101)return response;
  const headers=new Headers(response.headers);
  // Never inherit broad CORS or credential policies from a static binding.
  for(const name of ['Access-Control-Allow-Origin','Access-Control-Allow-Credentials',
    'Access-Control-Allow-Methods','Access-Control-Allow-Headers','Access-Control-Expose-Headers',
    'Access-Control-Max-Age'])headers.delete(name);
  vary(headers,['Origin']);
  const origin=nativeRequestOrigin(request);
  if(origin&&(request.method==='GET'||request.method==='HEAD')) {
    headers.set('Access-Control-Allow-Origin',origin);
    headers.set('Access-Control-Expose-Headers','ETag, Content-Length, Content-Range, Accept-Ranges');
  }
  // Keep streams, 304/206 status, MIME and explicit gzip bytes unchanged.
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

export function nativeCorsPreflight(request) {
  const origin=nativeRequestOrigin(request),method=request.headers.get('Access-Control-Request-Method');
  const requested=request.headers.get('Access-Control-Request-Headers');
  const headerNames=requested===null?[]:requested.split(',').map(value=>value.trim().toLowerCase());
  const allowedHeaders=new Set(['range','if-none-match','if-range']);
  const headers=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  vary(headers,['Origin','Access-Control-Request-Method','Access-Control-Request-Headers']);
  if(!origin||!['GET','HEAD'].includes(method)||new URL(request.url).pathname==='/ws/native'||
    headerNames.some(name=>!allowedHeaders.has(name)))
    return Response.json({error:'Preflight rejected'},{status:403,headers});
  headers.set('Access-Control-Allow-Origin',origin);
  headers.set('Access-Control-Allow-Methods','GET, HEAD');
  if(headerNames.length)headers.set('Access-Control-Allow-Headers',headerNames.join(', '));
  headers.set('Access-Control-Max-Age','600');
  return new Response(null,{status:204,headers});
}
