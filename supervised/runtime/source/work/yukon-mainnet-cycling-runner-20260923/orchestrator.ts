import type {Cpu} from './runtime-api';
/** Isolated orchestration. Provider network IO is supplied by a trusted caller. */
import {SCHEMA} from '../yukon-indexed-controller-20260923/identity-index';
import {createHash} from 'node:crypto';
import type {Store} from '../../outputs/qsb-vault/server/store';
import {BoundCoordinator} from './reference-binding';
import {GuardedIntents} from '../yukon-indexed-controller-20260923/guarded-intents';
import {Drain,type Terminal} from '../yukon-indexed-controller-20260923/drain';
import {saveObservation,savedTerminal} from '../yukon-indexed-controller-20260923/observations';
const ADAPTER='f82d12eb4ef56db8d1a896572d6397d3cd9c167830c48abfa9fa184eb883274e';
function canonical(x:any):string {
 if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
 if(x!==null&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>canonical(k)+':'+canonical(x[k])).join(',')+'}';
 if(typeof x==='number'&&!Number.isSafeInteger(x))throw Error('Noninteger protocol number');
 const value=JSON.stringify(x);if(value===undefined)throw Error('Invalid JSON value');
 return value.replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
function compute(e:any){return {action:'compute',runtimeHash:e.runtimeHash,request:e.request};}
export class Orchestrator {
 constructor(private s:Store,private scope:string,private owner:string,private revision:number,private endpoint:string,private cpu:Cpu){
  if(!/^[a-z0-9]+$/.test(endpoint)||['historical-proof-disabled-a','historical-proof-disabled-b'].includes(endpoint))throw Error('Invalid or spent endpoint');
 }
 private bound(){return new BoundCoordinator(this.s,this.scope,this.owner,this.revision,this.cpu);}
 private intents(){return new GuardedIntents(this.s,this.scope,this.owner,this.revision);}
 private async state(){const r=await this.s.get('VALIDATION#'+this.scope,'SCOPE');if(!r||r.identitySchema!==SCHEMA||r.owner!==this.owner||r.revision!==this.revision||r.endpoint!==this.endpoint||r.adapterHash!==ADAPTER)throw Error('Orchestrator binding mismatch');return r;}
 async initialize(event:unknown){await this.bound().initialize(event);const r=(await this.s.get('VALIDATION#'+this.scope,'SCOPE'))!;await this.s.put({...r,version:r.version+1,endpoint:this.endpoint,adapterHash:ADAPTER},r.version);}
 async configureBudget(maxSubmissions:number,deadlineMs:number){await this.state();return this.intents().configureBudget(maxSubmissions,deadlineMs);}
 async reserve(range:string,event:unknown){await this.state();return this.bound().reserve(range,event);}
 async submit(sk:string,send:(endpoint:string,event:unknown)=>Promise<{id:string}>){const scope=await this.state();if(!scope.budget)throw Error('Submission budget required');return this.intents().submit(sk,async e=>{const r=await send(this.endpoint,compute(e));return r?.id;});}
 async poll(sk:string,read:(endpoint:string,id:string)=>Promise<any>){
  let scope=await this.state();const r=await this.s.get(scope.pk,sk);
  if(!r||typeof r.provider!=='string'||r.owner!==this.owner||r.revision!==this.revision||!sk.startsWith(`RANGE#${scope.stage}:`))throw Error('Unattached/wrong-context provider');
  if(!['searching','draining'].includes(scope.phase as string))throw Error('Inactive scope');
  const saved=await savedTerminal(this.s,r);
  const result=structuredClone(saved===undefined?await read(this.endpoint,r.provider):saved);
  if(result?.id!==r.provider||!['IN_QUEUE','IN_PROGRESS','COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(result.status))throw Error('Invalid provider observation');
  if(['IN_QUEUE','IN_PROGRESS'].includes(result.status))return 'pending';
  if(saved===undefined)await saveObservation(this.s,scope,r,result);
  scope=await this.state();
  if(scope.phase==='draining'){
   await new Drain(this.s,this.scope,this.owner,this.revision).terminal(sk,async()=>({id:result.id,status:result.status,observedAt:new Date().toISOString()} as Terminal));return 'terminal';
  }
  if(scope.phase!=='searching')throw Error('Scope changed while reading');
  if(result.status!=='COMPLETED'){await this.intents().pauseForTerminal(sk,{id:result.id,status:result.status,observedAt:new Date().toISOString()});return 'paused';}
  const event=compute(JSON.parse(r.frozen as string));
  const t=result.output?.transport;
  if(!t||Object.keys(t).sort().join(',')!=='adapterSha256,inputSha256,providerJobId'||t.adapterSha256!==ADAPTER||t.providerJobId!==r.provider||t.inputSha256!==createHash('sha256').update(canonical(event)).digest('hex'))throw Error('Queue envelope mismatch');
  return this.bound().accept(sk,r.provider,result.output.runtime);
 }
}
