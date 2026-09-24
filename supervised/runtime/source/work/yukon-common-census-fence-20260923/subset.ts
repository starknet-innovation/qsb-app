import type {Cpu} from './runtime-api';
import {createHash} from 'node:crypto';
import {Conflict,type Store,type Row} from '../../outputs/qsb-vault/server/store';
import {operate,type Config} from './runner';
import {ProviderIO} from '../yukon-indexed-controller-20260923/provider-io';
import {IdentityIndex,SCHEMA} from '../yukon-indexed-controller-20260923/identity-index';
import type {Observation} from '../yukon-indexed-controller-20260923/execution-gate';
export type Enrollment={format:'qsb-supervised-controller-v1';runId:string;config:Config};
export type Event={event:string;[key:string]:unknown};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** One owned adapter per enrolled writer process. No paid retries, no standalone activation. */
export class SupervisedController {
 private stopPromise?:Promise<void>;private registered=false;private busy=false;private stopping=false;private stopped=false;private pending=new Set<string>();private unknown=new Set<string>();private abort=new AbortController();
 private readonly clockStart=Date.now();private readonly monoStart=performance.now();
 readonly config:Config;readonly configHash:string;private runPk:string;
 constructor(private store:Store,enrollment:Enrollment,private provider:ProviderIO,private observe:()=>Promise<Observation>,private emit:(event:Event)=>void,private preserveReceipt:(event:Event)=>Promise<void>,common:{runPk:string;configHash:string},private cpu:Cpu){
  enrollment=structuredClone(enrollment);
  if(enrollment.format!=='qsb-supervised-controller-v1'||!/^supervised-[a-z0-9-]{1,80}$/.test(enrollment.runId))throw Error('Invalid enrollment');
  const c=structuredClone(enrollment.config);
  if(![c.parent,c.scope].every(s=>/^isolated-yukon-[a-z0-9-]+$/.test(s))||c.parent===c.scope||!c.owner||!Number.isSafeInteger(c.revision)||c.revision<1||provider.endpoint!==c.endpoint)throw Error('Invalid enrolled scope');
  if(!Number.isSafeInteger(c.deadlineMs)||c.deadlineMs<=Date.now()||!Number.isSafeInteger(c.maxSubmissions)||c.maxSubmissions<1)throw Error('Invalid enrolled budget');
  if(common.runPk!=='SUPERVISION#'+enrollment.runId||!/^([a-f0-9]{64})$/.test(common.configHash))throw Error('Invalid common lifetime binding');
  this.config=Object.freeze(c);this.configHash=common.configHash;this.runPk=common.runPk;
 }
 private expired(){return Date.now()>=this.config.deadlineMs||performance.now()-this.monoStart>=this.config.deadlineMs-this.clockStart;}
 private budget(row:Row){const b=row.budget as any;if(!b||b.deadlineMs!==this.config.deadlineMs||b.maxSubmissions!==this.config.maxSubmissions||b.maxConcurrent!==1||this.expired())throw Error('Enrolled dispatch budget expired or changed');}
 private bound(e:Event){return {...e,...(typeof e.intent==='string'?{stage:e.intent.split(':')[0].replace('RANGE#','')}:{}),configHash:this.configHash,parent:this.config.parent,scope:this.config.scope,owner:this.config.owner,revision:this.config.revision};}
 private event(e:Event){this.emit(this.bound(e));}
 private async assertRegistered(){if(!this.registered)throw Error('Not initialized');await this.scopes();const o=await this.store.get(this.runPk,'OWNER');if(!o||o.configHash!==this.configHash||o.owner!==this.config.owner||o.revision!==this.config.revision)throw Error('Durable lifetime ownership changed');return o;}
 private async scopes(){
  const c=this.config,[p,s]=await Promise.all([this.store.get('VALIDATION#'+c.parent,'SCOPE'),this.store.get('VALIDATION#'+c.scope,'SCOPE')]);
  if(!p||!s||[p,s].some(x=>x.identitySchema!==SCHEMA||x.owner!==c.owner)||p.childScope!==c.scope||s.parentScope!==c.parent||p.pinReceiptHash!==s.pinReceiptHash||typeof p.pinReceiptHash!=='string')throw Error('Enrolled reciprocal scopes changed');
  if([p,s].some(x=>(this.registered||x.supervisedRun!==undefined)&&(x.supervisedRun!==this.runPk||x.supervisedConfigHash!==this.configHash)))throw Error('Scopes owned by another supervised lifetime');
  return {p,s};
 }
 async adoptLinkedLifetime(){
  const {p,s}=await this.scopes(),o=await this.store.get(this.runPk,'OWNER');
  if(!o||o.configHash!==this.configHash||o.lifecycle!=='subset'||o.activeOperation!==null||o.status!=='owned'||[p,s].some(x=>x.supervisedRun!==this.runPk||x.supervisedConfigHash!==this.configHash||x.dispatchClosed||x.identityConflict)||p.phase!=='subset_running'||s.phase!=='searching')throw Error('No atomic common-lifetime activation');
  this.registered=true;
 }
 private async durableOutcome(requestId:string,intent:string,status:'resolved'|'unknown'|'not_sent',providerId?:string){
  const start=await this.store.get(this.runPk,requestId);if(!start||start.status!=='started'||start.configHash!==this.configHash)throw Error('Missing durable start');
  const row:Row={...start,version:start.version+1,status,...(providerId?{providerId}:{})};
  const owner=await this.store.get(this.runPk,'OWNER');if(!owner||owner.configHash!==this.configHash)throw Error('Outcome lifetime differs');
  await this.store.atomicPut([{row,expected:start.version},{row:{...owner,version:owner.version+1},expected:owner.version}]);
  if(status==='unknown')this.unknown.add(requestId);
  this.pending.delete(requestId);
  if(status!=='not_sent')this.event({event:status==='resolved'?'request_resolved':'request_unknown',requestId,intent,...(providerId?{providerId}:{}),durableKey:{pk:row.pk,sk:row.sk,version:row.version}});
 }
 private async send(intent:string,endpoint:string,event:unknown){
  await this.assertRegistered();if(this.stopping)throw Error('Dispatch locally closed');
  const {p,s}=await this.scopes(),c=this.config;
  if([p,s].some(x=>x.identityConflict||x.dispatchClosed||x.revision!==c.revision)||p.phase!=='subset_running'||s.phase!=='searching')throw Error('Dispatch durably closed');
  const r=await this.store.get(s.pk,intent);if(!r||r.state!=='uncertain'||r.owner!==c.owner||r.revision!==c.revision||!Number.isSafeInteger(r.dispatchAuthorizedAtMs))throw Error('Missing controller dispatch claim');
  this.budget(s);
  const requestId='REQUEST#'+digest(s.pk+':'+intent),row:Row={pk:this.runPk,sk:requestId,version:1,status:'started',configHash:this.configHash,parent:c.parent,scope:c.scope,stage:intent.split(':')[0].replace('RANGE#',''),owner:c.owner,revision:c.revision,intent,endpoint};
  await this.store.atomicPut([{row:{...p,version:p.version+1},expected:p.version},{row:{...s,version:s.version+1},expected:s.version},{row}]);
  // No await between this local gate and event emission/transport entry. Stop control cannot overtake it.
  if(this.stopping||this.expired()){await this.durableOutcome(requestId,intent,'not_sent');throw Error('Stopped before transport entry');}
  this.pending.add(requestId);this.event({event:'request_started',requestId,intent,endpoint,durableKey:{pk:row.pk,sk:row.sk,version:row.version}});
  if(this.stopping||this.expired()){await this.durableOutcome(requestId,intent,'not_sent');throw Error('Expired before transport entry');}
  let result:{id:string};
  try{result=await this.provider.send(endpoint,event);}catch(error){await this.durableOutcome(requestId,intent,'unknown');throw error;}
  await this.preserveReceipt(this.bound({event:'request_observed',requestId,intent,providerId:result.id}));
  // All results must persist before notification; attachment may safely happen later after a pause.
  await new IdentityIndex(this.store,c.scope,c.owner,c.revision).record(intent,result.id);
  await this.durableOutcome(requestId,intent,'resolved',result.id);
  return result;
 }
 async operation(operation:string,intent?:string){
  await this.assertRegistered();if(this.busy)throw Error('One serialized operation at a time');
  if(this.stopping&&!['reconcile','recover-id'].includes(operation))throw Error('Dispatch stopped');
  this.busy=true;
  const self=this;
  class InstrumentedProvider extends ProviderIO {
   constructor(){super(self.provider.endpoint,`https://api.runpod.ai/v2/${self.provider.endpoint}/run`,'unused-delegated');}
   override send(endpoint:string,event:any){const inferred=intent??`RANGE#${event?.request?.stage}:${event?.request?.attempt}`;if(!/^RANGE#round[12]:(0|[1-9][0-9]*)$/.test(inferred))throw Error('No exact request intent');return self.send(inferred,endpoint,event);}
   override read(endpoint:string,id:string){return self.provider.read(endpoint,id);}
  }
  try{return await operate(this.store,this.config,new InstrumentedProvider(),this.observe,operation,intent,this.cpu,['reconcile','recover-id'].includes(operation)?undefined:this.abort.signal);}
  finally{this.busy=false;}
 }
 closeLocalGate(){this.stopping=true;this.abort.abort();}
 async transportDrained(){if(this.busy||this.pending.size||this.unknown.size)throw Error('Transport still pending');const rows=await this.store.list(this.runPk,'REQUEST#');if(rows.some(r=>!['resolved','not_sent'].includes(r.status as string)))throw Error('Durable unresolved transport');}
 stopDispatch(){if(!this.stopPromise)this.stopPromise=this.closeDispatch();return this.stopPromise;}
 private async closeDispatch(){
  if(!this.registered)throw Error('Not initialized');this.stopping=true;this.abort.abort();
  await this.assertRegistered();
  if(this.stopped)return;
  for(let attempt=0;attempt<32;attempt++){
   const {p,s}=await this.scopes();
   const closed=(r:Row)=>({...r,version:r.version+1,dispatchClosed:true,dispatchClosedBy:this.runPk,...(!r.identityConflict?{phase:'paused'}:{})});
   const owner=await this.store.get(this.runPk,'OWNER');if(!owner||owner.configHash!==this.configHash)throw Error('Supervisor ownership missing');
   try{await this.store.atomicPut([{row:closed(p),expected:p.version},{row:closed(s),expected:s.version},{row:{...owner,version:owner.version+1,status:'dispatch_stopped'},expected:owner.version}]);this.stopped=true;this.event({event:'dispatch_stopped',durableVersions:{parent:p.version+1,child:s.version+1,owner:owner.version+1},pending:[...this.pending],unknown:[...this.unknown],sealEligible:false});return;}
   catch(error){if(!(error instanceof Conflict))throw error;}
  }
  throw Error('Stop transaction contention; no acknowledgement');
 }
 async shutdown(){
  const lifetime=await this.assertRegistered();if(lifetime.status!=='dispatch_stopped')throw Error('No durable stop acknowledgement');
  const {p,s}=await this.scopes();if(!this.registered||[p,s].some(x=>!x.dispatchClosed||x.dispatchClosedBy!==this.runPk))throw Error('Closed registered scopes required');
  if(!this.stopped||this.busy||this.pending.size||this.unknown.size)throw Error('Not quiescent');
  const rows=await this.store.list(this.runPk,'REQUEST#');if(rows.some(r=>!['resolved','not_sent'].includes(r.status as string)))throw Error('Durable unknown/pending request');
  this.event({event:'shutdown_ready',controllerIntegrated:true,providerTerminalProven:false,sealEligible:false});
 }
}
