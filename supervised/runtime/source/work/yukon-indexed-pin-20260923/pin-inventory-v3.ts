import {assertIdentity} from './identity';
import type {Store,Row} from '../../outputs/qsb-vault/server/store';
import {IdentityIndex,SCHEMA} from '../yukon-indexed-controller-20260923/identity-index';
/** Local integration primitive. send/read/validate are trusted adapters, not public callbacks. */
export class PinInventoryV3 {
 private pk:string;
 constructor(private store:Store,private scopeName:string,private owner:string,private revision:number){if(!/^isolated-yukon-[a-z0-9-]+$/.test(scopeName)||!owner||!Number.isSafeInteger(revision)||revision<1)throw Error('Invalid owner');this.pk='VALIDATION#'+scopeName;}
 private async scope(phases=['pinning_searching']){const s=await this.store.get(this.pk,'SCOPE');if(!s||s.identitySchema!==SCHEMA||s.identityConflict||s.owner!==this.owner||s.revision!==this.revision||s.stage!=='pinning'||!phases.includes(s.phase as string))throw Error('Stale pin owner/phase');return s;}
 private async row(sk:string){if(!/^PIN#(0|[1-9][0-9]*)$/.test(sk))throw Error('Invalid pin range');const r=await this.store.get(this.pk,sk);if(!r||r.owner!==this.owner||r.revision!==this.revision)throw Error('Wrong pin intent');return r;}
 private async write(s:Row,r:Row,next:object,scopeNext:object={}){await this.store.atomicPut([{row:{...s,...scopeNext,version:s.version+1},expected:s.version},{row:{...r,...next,version:r.version+1},expected:r.version}]);}
 async reserve(attempt:number,payload:unknown,validate:(payload:unknown,scope:Row)=>Promise<void>){
  if(!Number.isSafeInteger(attempt)||attempt<0)throw Error('Invalid attempt');const frozen=JSON.stringify(payload);if(!frozen||Buffer.byteLength(frozen)>200000)throw Error('Invalid payload');const before=await this.scope();await validate(JSON.parse(frozen),structuredClone(before));const s=await this.scope();if(s.version!==before.version)throw Error('Scope changed during validation');
  await this.store.atomicPut([{row:{...s,version:s.version+1},expected:s.version},{row:{pk:this.pk,sk:'PIN#'+attempt,version:1,owner:this.owner,revision:this.revision,state:'reserved',frozen}},{row:{pk:this.pk,sk:'IDENTITY#PIN#'+attempt,version:1,owner:this.owner,revision:this.revision,intent:'PIN#'+attempt,count:0,ambiguous:false,schema:SCHEMA}}]);
 }
 async submit(sk:string,send:(payload:unknown)=>Promise<string>,preflight:()=>Promise<void>){
  const s=await this.scope(),r=await this.row(sk),b=s.budget as any;
  if(r.state!=='reserved'||!b||b.maxConcurrent!==1||!Number.isSafeInteger(b.maxSubmissions)||b.maxSubmissions<1||!Number.isSafeInteger(b.claimed)||b.claimed<0||b.claimed>=b.maxSubmissions||!Number.isSafeInteger(b.deadlineMs)||Date.now()>=b.deadlineMs)throw Error('Invalid claim or exhausted budget');
  const rows=await this.store.list(this.pk,'PIN#');if(rows.some(x=>['uncertain','attached'].includes(x.state as string)&&!x.terminal))throw Error('Pin slot occupied');
  await this.write(s,r,{state:'uncertain'},{budget:{...b,claimed:b.claimed+1}});
  if(Date.now()>=b.deadlineMs)throw Error('Deadline after claim; reconcile');
  await preflight();
  const latest=await this.scope(),claimed=await this.row(sk),budget=latest.budget as any;
  if(claimed.state!=='uncertain'||claimed.dispatchAuthorizedAtMs!==undefined||!budget||budget.deadlineMs!==b.deadlineMs||Date.now()>=budget.deadlineMs)throw Error('Invalid final dispatch fence');
  await this.write(latest,claimed,{dispatchAuthorizedAtMs:Date.now()});
  if(Date.now()>=budget.deadlineMs)throw Error('Deadline after dispatch fence; reconcile');
  // External POST cannot be atomic with the database. Any exception leaves uncertainty.
  const id=await send(JSON.parse(r.frozen as string));await this.attach(sk,id);return id;
 }
 async attach(sk:string,id:string){await this.row(sk);const index=new IdentityIndex(this.store,this.scopeName,this.owner,this.revision);await index.record(sk,id);return index.recover(sk);}
 async recover(sk:string){await this.row(sk);return new IdentityIndex(this.store,this.scopeName,this.owner,this.revision).recover(sk);}
 async terminal(sk:string,read:(id:string)=>Promise<{id:string;status:string;observedAt:string;candidate?:{sequence:number;locktime:number}}>){
  const before=await this.scope(['pinning_searching','pinning_draining']),r=await this.row(sk);if(r.state!=='attached'||typeof r.provider!=='string')throw Error('Unattached intent');const e=structuredClone(await read(r.provider));
  if(e.id!==r.provider||!['COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(e.status)||!Number.isFinite(Date.parse(e.observedAt)))throw Error('Missing terminal evidence');
  if(e.candidate&&(e.status!=='COMPLETED'||!Number.isInteger(e.candidate.sequence)||e.candidate.sequence<2147483648||e.candidate.sequence>4294967295||!Number.isInteger(e.candidate.locktime)||e.candidate.locktime<500000000||e.candidate.locktime>1744600000))throw Error('Invalid candidate');
  const s=await this.scope(['pinning_searching','pinning_draining']);await assertIdentity(this.store,r);if(s.version!==before.version)throw Error('Scope changed during provider read');
  await this.write(s,r,{terminal:e,...(e.candidate?{candidate:e.candidate,state:'candidate'}:{})},e.candidate?{phase:'pinning_draining'}:s.phase==='pinning_searching'&&e.status!=='COMPLETED'?{phase:'paused',revision:this.revision+1}:{});
 }
 async retire(sk:string){const s=await this.scope(['pinning_draining']),r=await this.row(sk);if(r.state!=='reserved'||r.provider)throw Error('Possibly submitted');await this.write(s,r,{state:'unsubmitted_retired'});}
}
