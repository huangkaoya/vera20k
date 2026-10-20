import type {EngineResult,Placement,Snapshot,VeraCommand,VeraConfig} from './types';
import type { RuntimeAssets } from '../config/runtime';

export class VeraEngine {
  private readonly worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});
  private pending=new Map<number,{resolve:(result:EngineResult)=>void;reject:(error:Error)=>void}>();
  private sequence=0;
  private disposed=false;
  constructor(onProgress:(message:string,progress:number)=>void, private readonly assets: RuntimeAssets){
    this.worker.onmessage=({data})=>{
      if(data.type==='progress'){onProgress(data.message,data.progress);return;}
      const request=this.pending.get(data.id); if(!request)return;
      this.pending.delete(data.id);
      if(data.result.ok)request.resolve(data.result);
      else {const error=new Error(data.result.error??'Simulation request failed');if(data.result.stack)error.stack=data.result.stack;request.reject(error);}
      if(data.fatal)this.dispose();
    };
    this.worker.onerror=(event)=>{this.failAll(new Error(event.message||'游戏引擎发生错误'));this.dispose();};
  }
  private failAll(error:Error){for(const item of this.pending.values())item.reject(error);this.pending.clear();}
  private request(request:unknown):Promise<EngineResult>{
    if(this.disposed)return Promise.reject(new Error('Simulation disposed'));
    return new Promise((resolve,reject)=>{const id=++this.sequence;this.pending.set(id,{resolve,reject});this.worker.postMessage({id,request,assets:this.assets,pageUrl:location.href});});
  }
  async init(config:VeraConfig):Promise<Snapshot>{const r=await this.request({op:'init',config});if(!r.snapshot)throw new Error('Missing initialized snapshot');return r.snapshot;}
  async step(commands:VeraCommand[],ticks=1):Promise<Snapshot>{const r=await this.request({op:'tick',commands,ticks});if(!r.snapshot)throw new Error('Missing simulation snapshot');return r.snapshot;}
  async snapshot(viewPlayer?:number):Promise<Snapshot>{const r=await this.request({op:'snapshot',viewPlayer});if(!r.snapshot)throw new Error('Missing snapshot');return r.snapshot;}
  async placement(typeId:string,rx:number,ry:number):Promise<Placement>{const r=await this.request({op:'placement',typeId,rx,ry});if(!r.placement)throw new Error('Missing placement result');return r.placement;}
  dispose(){if(this.disposed)return;this.disposed=true;this.worker.terminate();this.failAll(new Error('Simulation disposed'));}
}
