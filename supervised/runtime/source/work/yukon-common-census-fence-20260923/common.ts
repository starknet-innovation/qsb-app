import {commonCensus} from './census';
import {reconcileCommonNotSent} from './not-sent';
import type {CensusStore} from './census-store';
import type {Cpu,CpuOperation,OwnedRunner,Census} from './runtime-api';
import {PinControllerV3} from './pin-controller';
import {assertIdentity} from '../yukon-indexed-pin-20260923/identity';
import {createHash,randomUUID} from 'node:crypto';
import {Conflict,type Store,type Row} from '../../outputs/qsb-vault/server/store';
import {SupervisedPin,type Config as PinConfig} from './pin';
import {SupervisedController} from './subset';
import type {Config as SubsetConfig} from './runner';
import {ProviderIO as PinProvider} from '../yukon-v4-controller-20260923/provider-io';
import {ProviderIO as SubsetProvider} from '../yukon-indexed-controller-20260923/provider-io';
import {publishPin} from './publish-pin';
import {prepareSubsetChild} from './subset-child';
import {activateSubsetChild} from './activate-child';
export type Blueprint={format:'qsb-common-lifetime-v1';runId:string;pin:PinConfig;subset:SubsetConfig};
export type Drain={observedAtMs:number;endpoint:string;workersMin:number;workersMax:number;queued:number;inProgress:number};
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** Trusted common entry, not authorization for arbitrary raw Store callers. */
export class CommonLifetime {
 readonly blueprint:Blueprint;readonly configHash:string;private runPk:string;private pin:SupervisedPin;private subset:SupervisedController;private busy=false;private stopping=false;private stage:'pin'|'subset'='pin';private registered=false;private cpu:Cpu;private enrollmentSettled?:Promise<void>;private settleEnrollment?:()=>void;private stopPromise?:Promise<unknown>;
 constructor(private store:CensusStore,blueprint:Blueprint,private pinProvider:PinProvider,subsetProvider:SubsetProvider,private observePin:()=>Promise<any>,private observeSubset:()=>Promise<any>,private drain:()=>Promise<Drain>,private emit:(event:any)=>void,preserve:(event:any)=>Promise<void>,private runCpu:OwnedRunner,private preserveCpu:(event:any)=>Promise<void>){
  this.blueprint=Object.freeze({...structuredClone(blueprint),pin:Object.freeze(structuredClone(blueprint.pin)),subset:Object.freeze(structuredClone(blueprint.subset))});const {pin:p,subset:s}=this.blueprint;
  if(blueprint.format!=='qsb-common-lifetime-v1'||p.parent!==s.parent||p.owner!==s.owner||p.revision!==s.revision||p.endpoint===s.endpoint||s.scope===p.parent||typeof runCpu!=='function')throw Error('Invalid common blueprint');
  this.configHash=hash(this.blueprint);this.runPk='SUPERVISION#'+blueprint.runId;
  this.cpu=Object.freeze({pinExport:(e:any)=>this.cpuCall('pin-export-v4',e),pinCandidates:(e:any)=>this.cpuCall('pin-candidates-v5',e),pinHandoff:(e:any)=>this.cpuCall('pin-handoff-v5',e),subset:(e:any)=>{if(!['export','verify'].includes(e?.action))throw Error('No owned compute action');return this.cpuCall(e.action==='export'?'subset-export-v5':'subset-verify-v5',e);}});
  const binding={runPk:this.runPk,configHash:this.configHash};
  this.pin=new SupervisedPin(store,{format:'qsb-supervised-pin-v1',runId:blueprint.runId,config:p},pinProvider,observePin,emit,preserve,binding,this.cpu);
  this.subset=new SupervisedController(store,{format:'qsb-supervised-controller-v1',runId:blueprint.runId,config:s},subsetProvider,observeSubset,emit,preserve,binding,this.cpu);
 }
 async initialize(context:any){
  context=structuredClone(context);
  if(this.registered||this.busy||this.stopping)throw Error('Already initialized or stopped');this.busy=true;this.enrollmentSettled=new Promise(resolve=>{this.settleEnrollment=resolve;});
  const key='OPERATION#'+randomUUID(),p=this.blueprint.pin;
  try{
   if(await this.store.get('VALIDATION#'+p.parent,'SCOPE'))throw Error('No existing scope bootstrap');
   await this.store.atomicPut([{row:{pk:'VALIDATION#'+p.parent,sk:'SCOPE',version:1,owner:p.owner,revision:p.revision,endpoint:p.endpoint,stage:'pinning',phase:'bootstrap',identitySchema:'provider-index-v1',supervisedRun:this.runPk,supervisedConfigHash:this.configHash}},{row:{pk:this.runPk,sk:'OWNER',version:1,configHash:this.configHash,parent:p.parent,owner:p.owner,revision:p.revision,status:'operating',stage:'pinning',activeOperation:key,lifecycle:'bootstrap'}},{row:{pk:this.runPk,sk:key,version:1,status:'running',kind:'bootstrap',configHash:this.configHash}}]);this.registered=true;this.settleEnrollment?.();
   const base=this.store,self=this;
   const bootstrap:Store={get:base.get.bind(base),list:base.list.bind(base),delete:async()=>{throw Error('No bootstrap delete');},put:async(row,expected)=>{
    if(row.pk!=='VALIDATION#'+p.parent||row.sk!=='SCOPE'||expected!==undefined||self.stopping)throw Error('Unexpected bootstrap write');const o=await self.owner(),op=await base.get(self.runPk,key);if(o.activeOperation!==key||o.status!=='operating'||!op||op.status!=='running')throw Error('Bootstrap ownership lost');
    const placeholder=await base.get(row.pk,'SCOPE');if(!placeholder||placeholder.phase!=='bootstrap'||placeholder.dispatchClosed||placeholder.supervisedRun!==self.runPk||placeholder.supervisedConfigHash!==self.configHash)throw Error('Bootstrap scope changed');
    await base.atomicPut([{row:{...row,version:placeholder.version+1,supervisedRun:self.runPk,supervisedConfigHash:self.configHash},expected:placeholder.version},{row:{...o,version:o.version+1,status:'owned',lifecycle:'pin',activeOperation:null},expected:o.version},{row:{...op,version:op.version+1,status:'completed'},expected:op.version}]);
   },atomicPut:async()=>{throw Error('Unexpected bootstrap transaction');}};
   await new PinControllerV3(bootstrap,p.parent,p.owner,p.revision,this.pinProvider,this.observePin,this.cpu).initialize(context,{maxSubmissions:p.maxSubmissions,deadlineMs:p.deadlineMs});await this.pin.adoptBootstrap();
  }finally{this.settleEnrollment?.();this.busy=false;}
 }
 private async cpuCall(kind:CpuOperation,payload:any){
  payload=structuredClone(payload);const inputHash=hash(payload);
  const owner=await this.owner();if(this.stopping||owner.status!=='operating'||typeof owner.activeOperation!=='string')throw Error('CPU requires owned active operation');
  const operationKey=owner.activeOperation,scopeBinding={runPk:this.runPk,configHash:this.configHash,operationKey};let registered:any,completed:any;
  const census:Census={register:async(entry:any)=>{
   entry=structuredClone(entry);
   if(registered||this.stopping||entry.runtimeOperation!==kind||JSON.stringify(entry.scopeBinding)!==JSON.stringify(scopeBinding)||typeof entry.operation!=='string'||!/^[-a-z0-9]{1,100}$/.test(entry.operation))throw Error('Invalid CPU enrollment');
   const o=await this.owner(),op=await this.store.get(this.runPk,operationKey);if(o.activeOperation!==operationKey||o.status!=='operating'||!op||op.status!=='running')throw Error('CPU operation no longer current');
   const frozen=JSON.stringify(entry);await this.store.atomicPut([{row:{...o,version:o.version+1},expected:o.version},{row:{...op,version:op.version+1},expected:op.version},{row:{pk:this.runPk,sk:'CPU#'+entry.operation,version:1,status:'registered',kind,operationKey,configHash:this.configHash,inputHash,entry:frozen}}]);registered=structuredClone(entry);await this.preserveCpu({event:'cpu_registered',configHash:this.configHash,runPk:this.runPk,operation:entry.operation,entry:structuredClone(entry),durableKey:{pk:this.runPk,sk:'CPU#'+entry.operation,version:1}});if(this.stopping)throw Error('Stopped before CPU launch acknowledgement');
  },complete:async(receipt:any)=>{
   receipt=structuredClone(receipt);
   if(!registered||completed||receipt.operation!==registered.operation||JSON.stringify(receipt.scopeBinding)!==JSON.stringify(scopeBinding)||receipt.containerAbsent!==true||receipt.clientReaped!==true)throw Error('Unowned CPU completion');
   for(const [key,value]of Object.entries(registered))if(JSON.stringify(receipt[key])!==JSON.stringify(value))throw Error('CPU registration changed');
   const row=await this.store.get(this.runPk,'CPU#'+registered.operation),o=await this.owner(),op=await this.store.get(this.runPk,operationKey);if(!row||row.status!=='registered'||row.entry!==JSON.stringify(registered)||o.activeOperation!==operationKey||!op||op.status!=='running')throw Error('CPU census changed');
   await this.store.atomicPut([{row:{...o,version:o.version+1},expected:o.version},{row:{...op,version:op.version+1},expected:op.version},{row:{...row,version:row.version+1,status:'completed',receipt:JSON.stringify(receipt)},expected:row.version}]);completed=structuredClone(receipt);
  }};
  const out=await this.runCpu({operation:kind,payload:structuredClone(payload),scopeBinding},census);
  if(!registered||!completed||JSON.stringify(out.ownedVerification)!==JSON.stringify(completed))throw Error('CPU returned without owned cleanup');
  if(this.stopping)throw Error('Stopped during CPU operation');return out.result;
 }
 private async owner(){
  const o=await this.store.get(this.runPk,'OWNER');if(!this.registered||!o||o.configHash!==this.configHash||o.owner!==this.blueprint.pin.owner||o.revision!==this.blueprint.pin.revision)throw Error('Lifetime ownership mismatch');return o;
 }
 async operation(op:string,intent?:string){
  const owner=await this.owner();if(this.busy||this.stopping||owner.status!=='owned'||owner.activeOperation)throw Error('Common operation unavailable');this.busy=true;
  const key='OPERATION#'+randomUUID();
  try{
   const parent=await this.store.get('VALIDATION#'+this.blueprint.pin.parent,'SCOPE');if(!parent||parent.supervisedRun!==this.runPk||parent.supervisedConfigHash!==this.configHash||parent.dispatchClosed||parent.identityConflict)throw Error('Common parent closed');
   await this.store.atomicPut([{row:{...parent,version:parent.version+1},expected:parent.version},{row:{...owner,version:owner.version+1,status:'operating',activeOperation:key},expected:owner.version},{row:{pk:this.runPk,sk:key,version:1,status:'running',kind:this.stage+':'+op,intent:intent??null,configHash:this.configHash}}]);
   const result=this.stage==='pin'?await this.pin.operation(op,intent??''):await this.subset.operation(op,intent);
   const current=await this.owner(),operation=await this.store.get(this.runPk,key);if(current.activeOperation!==key||!operation||operation.status!=='running')throw Error('Operation ownership lost');
   await this.store.atomicPut([{row:{...current,version:current.version+1,status:this.stopping?'dispatch_stopped':'owned',activeOperation:null},expected:current.version},{row:{...operation,version:operation.version+1,status:'completed'},expected:operation.version}]);return result;
  }finally{this.busy=false;}
 }
 private async observeDrain(){const d=await this.drain();if(d.endpoint!==this.blueprint.pin.endpoint||!Number.isSafeInteger(d.observedAtMs)||Date.now()-d.observedAtMs<0||Date.now()-d.observedAtMs>60000||d.workersMin!==0||d.workersMax!==0||d.queued!==0||d.inProgress!==0)throw Error('Actual pin endpoint drain required');return d;}
 async extend(winner:string){
  await this.owner();if(this.stage!=='pin'||this.busy||this.stopping)throw Error('Extension unavailable');this.busy=true;this.pin.closeLocalGate();
  const p=this.blueprint.pin,s=this.blueprint.subset,pk='VALIDATION#'+p.parent,opKey='OPERATION#'+randomUUID();
  try{
   await this.pin.transportDrained();const firstDrain=await this.observeDrain(),owner=await this.owner(),parent=await this.store.get(pk,'SCOPE');
   if(!parent||parent.supervisedRun!==this.runPk||parent.supervisedConfigHash!==this.configHash||parent.phase!=='pinning_draining'||parent.identityConflict||parent.dispatchClosed||parent.childScope!==undefined||owner.activeOperation)throw Error('Parent not ready for extension');
   await this.store.atomicPut([{row:{...parent,version:parent.version+1},expected:parent.version},{row:{...owner,version:owner.version+1,status:'operating',activeOperation:opKey,lifecycle:'extending'},expected:owner.version},{row:{pk:this.runPk,sk:opKey,version:1,status:'running',kind:'pin-publication-child-bootstrap',configHash:this.configHash,firstDrain}}]);
   const guarded=this.extensionStore(opKey);
   await publishPin(guarded,p.parent,p.owner,p.revision,winner,this.cpu);
   await prepareSubsetChild(guarded,p.parent,s.scope,p.owner,p.revision,s.endpoint,this.cpu);
   await activateSubsetChild(guarded,p.parent,s.scope,p.owner,p.revision,{maxSubmissions:s.maxSubmissions,deadlineMs:s.deadlineMs},async()=>{await this.observeDrain();if(this.stopping)throw Error('Stopped during extension');return this.observeSubset();},this.cpu);
   if(this.stopping)throw Error('Stopped before subset adoption');await this.subset.adoptLinkedLifetime();this.stage='subset';return {extended:true,configHash:this.configHash,sealEligible:false};
  }finally{this.busy=false;}
 }
 private extensionStore(opKey:string):Store{
  const base=this.store,self=this;return {get:base.get.bind(base),list:base.list.bind(base),delete:async()=>{throw Error('No bootstrap deletion');},put:(row,expected)=>self.extensionStore(opKey).atomicPut([{row,expected}]),atomicPut:async writes=>{
   if(self.stopping)throw Error('Stopped extension');const o=await self.owner(),op=await base.get(self.runPk,opKey);if(o.activeOperation!==opKey||o.status!=='operating'||!op||op.status!=='running')throw Error('Extension ownership lost');
   const enriched=structuredClone(writes),child=enriched.find(w=>w.row.pk==='VALIDATION#'+self.blueprint.subset.scope&&w.row.sk==='SCOPE');
   if(child){if(child.row.supervisedRun!==undefined&&child.row.supervisedRun!==self.runPk)throw Error('Foreign child supervision');child.row={...child.row,supervisedRun:self.runPk,supervisedConfigHash:self.configHash};}
   const final=child?.row.phase==='searching';
   enriched.push({row:{...o,version:o.version+1,...(final?{status:'owned',lifecycle:'subset',activeOperation:null,scope:self.blueprint.subset.scope}:{})},expected:o.version},{row:{...op,version:op.version+1,...(final?{status:'completed'}:{})},expected:op.version});
   await base.atomicPut(enriched);
  }};
 }
 async reconcileNotSent(pending:any,writerHash:string){
  pending=structuredClone(pending);if(this.busy)throw Error('Operation still running');await this.stop();return reconcileCommonNotSent(this.store,this.blueprint,this.configHash,pending,writerHash);
 }
 async shutdown(){
  await this.stop();if(this.busy)throw Error('Operation still running');const result=await commonCensus(this.store,this.blueprint,this.configHash);this.emit({event:'shutdown_ready',configHash:this.configHash,runPk:this.runPk,snapshotHash:result.snapshotHash,durableOwnerVersion:result.durableOwnerVersion,providerTerminalProven:false,processExitProven:false,sealEligible:false});return result;
 }
 stop(){this.stopping=true;this.pin.closeLocalGate();this.subset.closeLocalGate();if(!this.stopPromise)this.stopPromise=this.stopAfterEnrollment();return this.stopPromise;}
 private async stopAfterEnrollment(){
  await this.enrollmentSettled;
  if(!this.registered){const o=await this.store.get(this.runPk,'OWNER');if(!o||o.configHash!==this.configHash||o.owner!==this.blueprint.pin.owner||o.revision!==this.blueprint.pin.revision)throw Error('No confirmed owned enrollment');this.registered=true;}
  return this.persistStop();
 }
 private async persistStop(){
  for(let attempt=0;attempt<32;attempt++){
   const o=await this.owner(),p=await this.store.get('VALIDATION#'+this.blueprint.pin.parent,'SCOPE'),c=await this.store.get('VALIDATION#'+this.blueprint.subset.scope,'SCOPE');
   if(!p||p.identitySchema!=='provider-index-v1'||p.endpoint!==this.blueprint.pin.endpoint||p.owner!==this.blueprint.pin.owner||p.supervisedRun!==this.runPk||p.supervisedConfigHash!==this.configHash)throw Error('Stop ownership lost');
   if(c&&(c.identitySchema!=='provider-index-v1'||c.endpoint!==this.blueprint.subset.endpoint||c.owner!==this.blueprint.subset.owner||c.supervisedRun!==this.runPk||c.supervisedConfigHash!==this.configHash||c.parentScope!==this.blueprint.pin.parent))throw Error('Foreign child cannot be stopped');
   const scopes=[p,...(c?[c]:[])],evidence:Row[]=[];
   if(c&&(p.childScope!==this.blueprint.subset.scope||p.pinReceiptHash!==c.pinReceiptHash||typeof p.pinReceiptHash!=='string'))throw Error('Reciprocal stop binding changed');
   for(const scope of scopes){
    if(scope.revision===this.blueprint.pin.revision)continue;
    if(scope.revision!==this.blueprint.pin.revision+1||scope.phase!=='paused'||scope.identityConflict)throw Error('Stop revision is not a single terminal pause');
    const prefix=scope.pk===p.pk?'PIN#':'RANGE#',rows=await this.store.list(scope.pk,prefix);
    const failed=rows.find(r=>r.owner===this.blueprint.pin.owner&&r.revision===this.blueprint.pin.revision&&typeof r.provider==='string'&&(r.terminal as any)?.id===r.provider&&['FAILED','CANCELLED','TIMED_OUT'].includes((r.terminal as any)?.status)&&Number.isFinite(Date.parse((r.terminal as any)?.observedAt)));
    if(!failed)throw Error('No exact failed terminal for pause');const index=await assertIdentity(this.store,failed);evidence.push(failed,index);
   }
   try{await this.store.atomicPut([...evidence.map(r=>({row:{...r,version:r.version+1},expected:r.version})),...scopes.map(r=>({row:{...r,version:r.version+1,dispatchClosed:true,dispatchClosedBy:this.runPk,stopTransition:r.stopTransition??{fromVersion:r.version,fromPhase:r.phase,fromStage:r.stage,rowHash:hash(r)},...(!r.identityConflict?{phase:'paused'}:{})},expected:r.version})),{row:{...o,version:o.version+1,status:'dispatch_stopped'},expected:o.version}]);const event={event:'common_dispatch_stopped',configHash:this.configHash,runPk:this.runPk,ownerVersion:o.version+1,scopeVersions:scopes.map(r=>({pk:r.pk,version:r.version+1})),sealEligible:false};this.emit(event);return event;}catch(e){if(!(e instanceof Conflict))throw e;}
  }throw Error('Stop contention; no acknowledgement');
 }
}
