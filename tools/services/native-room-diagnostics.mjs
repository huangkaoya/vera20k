// Internal diagnostics intentionally omit exception messages and raw stacks:
// either may contain client-controlled text or credentials from an I/O error.
const names=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError','AggregateError','DOMException','InternalError']);
const callbacks=new Set(['connect','message','close','error','watchdog','heartbeat','room-timer','client-count','idle-close','internal-cleanup']);
export function nativeInternalErrorDetails(error,callback) {
  const source=typeof error?.stack==='string'?error.stack:'';
  const frames=[...new Set(source.match(/(?:native-worker|native-room-coordinator|native-room-diagnostics|native-websocket|index|worker|_worker)\.(?:mjs|js):\d{1,10}:\d{1,10}/g)??[])].slice(0,8);
  return {event:'native-internal-error',atMs:Date.now(),callback:callbacks.has(callback)?callback:'unknown',
    errorName:names.has(error?.name)?error.name:'Error',frames};
}
