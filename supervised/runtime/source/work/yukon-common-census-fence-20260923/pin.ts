import type {Cpu} from './runtime-api';
import {createHash} from 'node:crypto';
import {Conflict,type Store,type Row} from '../../outputs/qsb-vault/server/store';
import {PinControllerV3} from './pin-controller';
import {PinInventoryV3} from '../yukon-indexed-pin-20260923/pin-inventory-v3';
export type Config={parent:string;owner:string;revision:number;endpoint:string;deadlineMs:number;maxSubmissions:number};
import {ProviderIO} from '../yukon-v4-controller-20260923/provider-io';
import {IdentityIndex,SCHEMA} from '../yukon-indexed-controller-20260923/identity-index';
import type {Observation} from '../yukon-pin-preflight-20260923/execution-gate';
export type Enrollment={format:'qsb-supervised-pin-v1';runId:string;config:Config};
export type Event={event:string;[key:string]:unknown};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** One owned adapter per enrolled writer process. No paid retries, no standalone activation. */
export class SupervisedPin {
 private stopPromise?:Promise<void>;private registered=false;private busy=false;private stopping=false;private stopped=false;private pending=new Set<string>();private unknown=new Set<string>();
 private readonly clockStart=Date.now();private readonly monoStart=performance.now();
 readonly config:Config;readonly configHash:string;private runPk:string;
 constructor(private store:Store,enrollment:Enrollment,private provider:ProviderIO,private observe:()=>Promise<Observation>,private emit:(event:Event)=>void,private preserveReceipt:(event:Event)=>Promise<void>,common:{runPk:string;configHash:string},private cpu:Cpu){
  enrollment=structuredClone(enrollment);
  if(enrollment.format!=='qsb-supervised-pin-v1'||!/^supervised-[a-z0-9-]{1,80}$/.test(enrollment.runId))throw Error('Invalid enrollment');
  const c=structuredClone(enrollment.config);
  if(!/^isolated-yukon-[a-z0-9-]+$/.test(c.parent)||!c.owner||!Number.isSafeInteger(c.revision)||c.revision<1||provider.endpoint!==c.endpoint||['historical-proof-disabled-a','historical-proof-disabled-b'].includes(c.endpoint))throw Error('Invalid enrolled scope');
  if(!Number.isSafeInteger(c.deadlineMs)||c.deadlineMs<=Date.now()||!Number.isSafeInteger(c.maxSubmissions)||c.maxSubmissions<1)throw Error('Invalid enrolled budget');
  if(common.runPk!=='SUPERVISION#'+enrollment.runId||!/^([a-f0-9]{64})$/.test(common.configHash))throw Error('Invalid common lifetime binding');
  this.config=Object.freeze(c);this.configHash=common.configHash;this.runPk=common.runPk;
 }
 private expired(){return Date.now()>=this.config.deadlineMs||performance.now()-this.monoStart>=this.config.deadlineMs-this.clockStart;}
 private budget(row:Row){const b=row.budget as any;if(!b||b.deadlineMs!==this.config.deadlineMs||b.maxSubmissions!==this.config.maxSubmissions||b.maxConcurrent!==1||this.expired())throw Error('Enrolled dispatch budget expired or changed');}
 private bound(e:Event){return {...e,configHash:this.configHash,parent:this.config.parent,stage:'pinning',owner:this.config.owner,revision:this.config.revision};}
 private event(e:Event){this.emit(this.bound(e));}
 private async assertRegistered(){if(!this.registered)throw Error('Not initialized');await this.scopes();const o=await this.store.get(this.runPk,'OWNER');if(!o||o.configHash!==this.configHash||o.owner!==this.config.owner||o.revision!==this.config.revision)throw Error('Durable lifetime ownership changed');return o;}
 private async scopes(){
  const c=this.config,p=await this.store.get('VALIDATION#'+c.parent,'SCOPE');
  if(!p||p.identitySchema!==SCHEMA||p.owner!==c.owner||p.revision!==c.revision||p.stage!=='pinning'||p.endpoint!==c.endpoint||p.childScope!==undefined)throw Error('Enrolled pin parent changed');
  if((this.registered||p.supervisedRun!==undefined)&&(p.supervisedRun!==this.runPk||p.supervisedConfigHash!==this.configHash))throw Error('Parent owned by another lifetime');
  return {p};
 }
 async adoptBootstrap(){const {p}=await this.scopes(),o=await this.store.get(this.runPk,'OWNER');if(p.supervisedRun!==this.runPk||p.supervisedConfigHash!==this.configHash||p.phase!=='pinning_searching'||p.dispatchClosed||p.identityConflict||!o||o.status!=='owned'||o.activeOperation!==null||o.configHash!==this.configHash)throw Error('No owned bootstrap');this.registered=true;}
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
  const {p}=await this.scopes(),c=this.config;
  if(p.identityConflict||p.dispatchClosed||p.revision!==c.revision||p.phase!=='pinning_searching')throw Error('Dispatch durably closed');
  const r=await this.store.get(p.pk,intent);if(!r||r.state!=='uncertain'||r.owner!==c.owner||r.revision!==c.revision||!Number.isSafeInteger(r.dispatchAuthorizedAtMs))throw Error('Missing controller dispatch claim');
  this.budget(p);
  const requestId='REQUEST#'+digest(p.pk+':'+intent),row:Row={pk:this.runPk,sk:requestId,version:1,status:'started',configHash:this.configHash,parent:c.parent,stage:'pinning',owner:c.owner,revision:c.revision,intent,endpoint};
  await this.store.atomicPut([{row:{...p,version:p.version+1},expected:p.version},{row}]);
  // No await between this local gate and event emission/transport entry. Stop control cannot overtake it.
  if(this.stopping||this.expired()){await this.durableOutcome(requestId,intent,'not_sent');throw Error('Stopped before transport entry');}
  this.pending.add(requestId);this.event({event:'request_started',requestId,intent,endpoint,durableKey:{pk:row.pk,sk:row.sk,version:row.version}});
  if(this.stopping||this.expired()){await this.durableOutcome(requestId,intent,'not_sent');throw Error('Expired before transport entry');}
  let result:{id:string};
  try{result=await this.provider.send(endpoint,event);}catch(error){await this.durableOutcome(requestId,intent,'unknown');throw error;}
  await this.preserveReceipt(this.bound({event:'request_observed',requestId,intent,providerId:result.id}));
  // All results must persist before notification; attachment may safely happen later after a pause.
  await new IdentityIndex(this.store,c.parent,c.owner,c.revision).record(intent,result.id);
  await this.durableOutcome(requestId,intent,'resolved',result.id);
  return result;
 }
 async operation(operation:string,intent:string){
  await this.assertRegistered();if(this.busy)throw Error('One serialized operation at a time');
  if(!['reserve','submit','recover-id','poll'].includes(operation))throw Error('Unsupported parent operation');
  if(this.stopping&&operation!=='recover-id')throw Error('Dispatch stopped');
  if(!/^PIN#(0|[1-9][0-9]*)$/.test(intent))throw Error('Explicit pin intent required');
  this.busy=true;const self=this;
  class InstrumentedProvider extends ProviderIO {
   constructor(){super(self.provider.endpoint,`https://api.runpod.ai/v2/${self.provider.endpoint}/run`,'unused-delegated');}
   override send(endpoint:string,event:unknown){return self.send(intent,endpoint,event);}
   override read(endpoint:string,id:string){return self.provider.read(endpoint,id);}
  }
  const observe=async()=>{if(this.stopping)throw Error('Dispatch stopped');const o=await this.observe();if(this.stopping)throw Error('Dispatch stopped');return o;};
  const c=new PinControllerV3(this.store,this.config.parent,this.config.owner,this.config.revision,new InstrumentedProvider(),observe,this.cpu);
  try{
   if(operation==='reserve')return await c.reserve(Number(intent.slice(4)));
   if(operation==='submit')return await c.submit(intent);
   if(operation==='poll')return await c.poll(intent);
   const i=new PinInventoryV3(this.store,this.config.parent,this.config.owner,this.config.revision);
   return await i.recover(intent);
  }finally{this.busy=false;}
 }
 closeLocalGate(){this.stopping=true;}
 async transportDrained(){if(this.busy||this.pending.size||this.unknown.size)throw Error('Transport still pending');const rows=await this.store.list(this.runPk,'REQUEST#');if(rows.some(r=>!['resolved','not_sent'].includes(r.status as string)))throw Error('Durable unresolved transport');}
 stopDispatch(){if(!this.stopPromise)this.stopPromise=this.closeDispatch();return this.stopPromise;}
 private async closeDispatch(){
  if(!this.registered)throw Error('Not initialized');this.stopping=true;
  await this.assertRegistered();
  if(this.stopped)return;
  for(let attempt=0;attempt<32;attempt++){
   const {p}=await this.scopes();
   const closed=(r:Row)=>({...r,version:r.version+1,dispatchClosed:true,dispatchClosedBy:this.runPk,...(!r.identityConflict?{phase:'paused'}:{})});
   const owner=await this.store.get(this.runPk,'OWNER');if(!owner||owner.configHash!==this.configHash)throw Error('Supervisor ownership missing');
   try{await this.store.atomicPut([{row:closed(p),expected:p.version},{row:{...owner,version:owner.version+1,status:'dispatch_stopped'},expected:owner.version}]);this.stopped=true;this.event({event:'dispatch_stopped',durableVersions:{parent:p.version+1,owner:owner.version+1},pending:[...this.pending],unknown:[...this.unknown],sealEligible:false});return;}
   catch(error){if(!(error instanceof Conflict))throw error;}
  }
  throw Error('Stop transaction contention; no acknowledgement');
 }
 async shutdown(){
  const lifetime=await this.assertRegistered();if(lifetime.status!=='dispatch_stopped')throw Error('No durable stop acknowledgement');
  const {p}=await this.scopes();if(!this.registered||(p.dispatchClosed!==true||p.dispatchClosedBy!==this.runPk))throw Error('Closed registered scopes required');
  if(!this.stopped||this.busy||this.pending.size||this.unknown.size)throw Error('Not quiescent');
  const rows=await this.store.list(this.runPk,'REQUEST#');if(rows.some(r=>!['resolved','not_sent'].includes(r.status as string)))throw Error('Durable unknown/pending request');
  this.event({event:'shutdown_ready',controllerIntegrated:true,providerTerminalProven:false,sealEligible:false});
 }
}
