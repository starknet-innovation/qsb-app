import {createHash} from 'node:crypto';
import type {Store} from '../../outputs/qsb-vault/server/store';
import {GuardedIntents} from '../yukon-indexed-controller-20260923/guarded-intents';
import {publish,type Verdict} from '../yukon-indexed-controller-20260923/publication';
import {RUNTIME as HASH} from './runtime-api';
import type {Cpu} from './runtime-api';
function canonical(x:any):string {if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x!==null&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';return JSON.stringify(x);}
function scopeBinding(e:any){const {stage,...context}=e.context;return createHash('sha256').update(canonical({context,runtimeHash:e.runtimeHash,solverId:e.request.solverId,solverReleaseHash:e.request.solverReleaseHash})).digest('hex');}
function check(e:any,range:string){
 if(!e||Object.keys(e).sort().join(',')!=='action,context,request,runtimeHash'||e.action!=='verify'||e.runtimeHash!==HASH)throw Error('Wrong runtime envelope');
 if(!['round1','round2'].includes(e.request?.stage)||!Number.isSafeInteger(e.request.attempt)||e.request.attempt<0||e.request.attempt>4828||range!==`${e.request.stage}:${e.request.attempt}`)throw Error('Range binding mismatch');
}
export class BoundCoordinator {
 constructor(private store:Store,private scope:string,private owner:string,private revision:number,private cpu:Cpu){}
 private intents(){return new GuardedIntents(this.store,this.scope,this.owner,this.revision);}
 async initialize(event:any){check(event,`${event.request.stage}:${event.request.attempt}`);await this.intents().initialize();const row=(await this.store.get('VALIDATION#'+this.scope,'SCOPE'))!;await this.store.put({...row,version:row.version+1,publicBinding:scopeBinding(event)},row.version);}
 async reserve(range:string,event:any){
  const frozen=JSON.parse(JSON.stringify(event));check(frozen,range);
  return this.intents().reserve(range,frozen,async(e:any)=>{
   const row=await this.store.get('VALIDATION#'+this.scope,'SCOPE');if(row?.publicBinding!==scopeBinding(e))throw Error('Different public context in scope');
   const exported=await this.cpu.subset({...e,action:'export'});
   if(exported.runtimeHash!==HASH||['parameterBase64','parameterSha256'].some(k=>exported[k]!==e.request[k]))throw Error('Parameter binding mismatch');
  });
 }
 async accept(sk:string,provider:string,output:unknown){return publish(this.store,this.scope,this.owner,this.revision,sk,provider,output,async(frozen:any,result)=>{
  check(frozen,sk.replace(/^RANGE#/,''));const row=await this.store.get('VALIDATION#'+this.scope,'SCOPE');if(row?.publicBinding!==scopeBinding(frozen))throw Error('Scope context mismatch');
  const verdict=await this.cpu.subset({...frozen,output:result});if(verdict.runtimeHash!==HASH)throw Error('CPU identity mismatch');return verdict as Verdict;
 });}
}
