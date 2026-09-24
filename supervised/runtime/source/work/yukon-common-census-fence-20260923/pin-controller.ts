import type {Cpu} from './runtime-api';
import {SCHEMA} from '../yukon-indexed-controller-20260923/identity-index';
import {assertIdentity} from '../yukon-indexed-pin-20260923/identity';
import {saveObservation,readObservation} from '../yukon-pin-controller-20260923/observations';
import type {Store} from '../../outputs/qsb-vault/server/store';
import {createHash} from 'node:crypto';
import {canonical} from '../../outputs/qsb-vault/src/lib/provenance';
import {pinRequest,pinResult} from '../yukon-pin-adapter-20260923/adapter';
import {PinInventoryV3} from '../yukon-indexed-pin-20260923/pin-inventory-v3';
import {ProviderIO} from '../yukon-v4-controller-20260923/provider-io';
import {validateExecution,type Observation} from '../yukon-pin-preflight-20260923/execution-gate';
export class PinControllerV3 {
 private pk:string;private intents:PinInventoryV3;
 constructor(private store:Store,private scope:string,private owner:string,private revision:number,private provider:ProviderIO,private observe:()=>Promise<Observation>,private cpu:Cpu){this.intents=new PinInventoryV3(store,scope,owner,revision);this.pk='VALIDATION#'+scope;}
 private async state(){const s=await this.store.get(this.pk,'SCOPE');if(!s||s.identitySchema!==SCHEMA||s.identityConflict||s.owner!==this.owner||s.revision!==this.revision||s.endpoint!==this.provider.endpoint)throw Error('Controller ownership mismatch');return s;}
 async initialize(context:any,budget:{maxSubmissions:number;deadlineMs:number}){
  const frozen=JSON.stringify(context);if(!frozen||Buffer.byteLength(frozen)>200000||context.network!=='regtest'||Object.keys(context).sort().join(',')!=='manifest,network,publicStateJson'||['historical-spent-fixture-0','historical-spent-fixture-1','historical-spent-fixture-2'].some(x=>frozen.toLowerCase().includes(x)))throw Error('Fresh public regtest context required');
  if(!Number.isSafeInteger(budget.maxSubmissions)||budget.maxSubmissions<1||budget.maxSubmissions>10000||!Number.isSafeInteger(budget.deadlineMs)||budget.deadlineMs<=Date.now()||budget.deadlineMs>Date.now()+1800000)throw Error('Invalid isolated budget');
  const ctx=JSON.parse(frozen),parameters=await this.cpu.pinExport(ctx);pinRequest(0,'0'.repeat(64),parameters);
  const publicContextHash=createHash('sha256').update(canonical(ctx).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))).digest('hex');
  await this.store.put({pk:this.pk,sk:'SCOPE',version:1,owner:this.owner,revision:this.revision,endpoint:this.provider.endpoint,identitySchema:SCHEMA,stage:'pinning',phase:'pinning_searching',publicContext:frozen,publicContextHash,pinParameters:parameters,budget:{...budget,claimed:0,maxConcurrent:1}});
 }
 async reserve(attempt:number){const s=await this.state(),ctx=JSON.parse(s.publicContext as string);const req=pinRequest(attempt,createHash('sha256').update(JSON.stringify(ctx.manifest)).digest('hex'),s.pinParameters as any);await this.intents.reserve(attempt,req,async(_,current)=>{if(current.version!==s.version)throw Error('Context changed');});}
 async submit(sk:string){return this.intents.submit(sk,async payload=>(await this.provider.send(this.provider.endpoint,payload)).id,async()=>{const s=await this.state();validateExecution(this.provider.endpoint,(s.budget as any).deadlineMs,await this.observe());});}
 async poll(sk:string){
  let s=await this.state(),r=await this.store.get(this.pk,sk);if(!r||r.state!=='attached'||r.owner!==this.owner||r.revision!==this.revision||typeof r.provider!=='string'||s.phase!=='pinning_searching')throw Error('Not current attached search');
  if(!r.observation){const journals=await this.store.list(this.pk,`OBS_RECEIPT#${r.sk}:`);if(journals.length>1)throw Error('Conflicting saved observations; reconcile');if(journals.length===1)r={...r,observation:journals[0].observation};}
  const status=r.observation?await readObservation(this.store,r):await this.provider.read(this.provider.endpoint,r.provider as string);if(['IN_PROGRESS','IN_QUEUE'].includes(status.status))return 'pending';
  if(!r.observation){const saved=await saveObservation(this.store,s,r,status);s=saved.scope;r=saved.intent;}
  if(status.status!=='COMPLETED'){await this.intents.terminal(sk,async()=>({id:status.id,status:status.status,observedAt:new Date().toISOString()}));return 'paused';}
  const checked=pinResult(JSON.parse(r.frozen as string),status.output);
  if(checked.pins.length){
   const cpu=await this.cpu.pinCandidates({...JSON.parse(s.publicContext as string),candidates:status.output.candidates});
   const v=cpu.verdict;
   if(cpu.runtimeHash!=='14ca2c729ecee121c715b7ff1acb9b8656b8650f8f4c02e3454c1067d22edeb9'||v?.valid!==true||!checked.pins.some(x=>x.sequence===v.sequence&&x.locktime===v.locktime))throw Error('No CPU-verified in-range pin; preserve for review');
   if((await this.state()).version!==s.version)throw Error('Scope changed during CPU verification');
   await this.intents.terminal(sk,async()=>({id:status.id,status:'COMPLETED',observedAt:new Date().toISOString(),candidateCount:checked.pins.length,observationRef:r.observation,cpuVerification:cpu,candidate:{sequence:v.sequence,locktime:v.locktime}}));return 'candidate_cpu_verified';
  }
  if(!Number.isSafeInteger(s.completedRanges??0)||(s.completedRanges as number??0)<0||(s.completedRanges as number??0)>=Number.MAX_SAFE_INTEGER)throw Error('Invalid range count');
  const identity=await assertIdentity(this.store,r);
  await this.store.atomicPut([{row:{...identity,version:identity.version+1},expected:identity.version},{row:{...s,version:s.version+1,completedRanges:Number(s.completedRanges??0)+1},expected:s.version},{row:{...r,version:r.version+1,state:'range_complete',terminal:{id:status.id,status:'COMPLETED',observedAt:new Date().toISOString()},receipt:checked},expected:r.version}]);return 'range_complete';
 }
}
