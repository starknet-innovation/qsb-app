/** Read-only next-action planner. Every mutation still rechecks CAS/CPU/provider guards. */
import {SCHEMA} from './identity-index';
import type {Store,Row} from '../../outputs/qsb-vault/server/store';
const choose=(n:bigint,k:bigint)=>{let v=1n;for(let i=1n;i<=k;i++)v=v*(n-i+1n)/i;return v;};
export const DOMAIN=choose(150n,9n),CHUNK=1n<<34n,RANGES=Number((DOMAIN+CHUNK-1n)/CHUNK);
export function expectedRange(attempt:number){
 if(!Number.isSafeInteger(attempt)||attempt<0||attempt>=RANGES)throw Error('Invalid subset attempt');
 const start=BigInt(attempt)*CHUNK,count=DOMAIN-start<CHUNK?DOMAIN-start:CHUNK;
 return {version:'ranked-v2',start:String(start),count:Number(count)};
}
export type Plan={action:'reserve'|'submit'|'poll'|'retire'|'advance'|'reconcile'|'stopped'|'budget_exhausted'|'domain_exhausted';scopeVersion:number;stage:string;intent?:string;reason?:string};
export async function nextAction(store:Store,scope:string,owner:string,revision:number,now=Date.now()):Promise<Plan>{
 if(!/^isolated-yukon-[a-z0-9-]+$/.test(scope))throw Error('Isolated scope required');
 const pk='VALIDATION#'+scope,s=await store.get(pk,'SCOPE');
 if(!s||s.identitySchema!==SCHEMA||s.owner!==owner||s.revision!==revision||!['round1','round2'].includes(s.stage as string))throw Error('Stale scheduler owner');
 const base={scopeVersion:s.version,stage:s.stage as string};
 if(!['searching','draining'].includes(s.phase as string))return {...base,action:'stopped',reason:String(s.phase)};
 const rows=await store.list(pk,`RANGE#${s.stage}:`),seen=new Map<number,Row>();
 for(const row of rows){
  const text=row.sk.slice(`RANGE#${s.stage}:`.length),n=Number(text);
  if(!/^(0|[1-9][0-9]*)$/.test(text)||n>=RANGES||seen.has(n)||row.owner!==owner||row.revision!==revision)throw Error('Invalid scheduler inventory');
  seen.set(n,row);
 }
 const after=await store.get(pk,'SCOPE');if(!after||after.version!==s.version)throw Error('Scheduler snapshot changed');
 const ordered=[...seen].sort((a,b)=>a[0]-b[0]);
 // Unknown submissions always block new paid work, even when later rows completed.
 for(const [,r] of ordered)if(r.state==='uncertain')return {...base,action:'reconcile',intent:r.sk,reason:'uncertain submission'};
 for(const [n,r] of ordered){
  if(r.state==='range_complete'){
   const v=r.receipt as any,w=expectedRange(n);
   if(!r.provider||v?.decision!=='range_complete'||v.referenceChecked!==true||v.eligibleForRangeCredit!==true||v.verdict?.valid!==false||!v.workRange||Object.keys(v.workRange).sort().join(',')!=='count,start,version'||v.workRange.version!==w.version||v.workRange.start!==w.start||v.workRange.count!==w.count)throw Error('Unproven range coverage');
  }else if(!['attached','reserved','candidate_verified','unsubmitted_retired'].includes(r.state as string))throw Error('Unknown intent state');
  if(r.state==='attached'&&s.phase==='searching')return {...base,action:'poll',intent:r.sk};
 }
 if(s.phase==='draining'){
  for(const [,r] of ordered){
   if(r.state==='reserved')return {...base,action:'retire',intent:r.sk};
   if(r.state==='unsubmitted_retired'){if(r.provider)throw Error('Retired provider intent');continue;}
   const t=r.terminal as any;
   if(!t)return {...base,action:'poll',intent:r.sk};
   if(t.id!==r.provider||!['COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(t.status))throw Error('Invalid terminal receipt');
  }
  // Drain.advance rechecks verified winner and all terminal evidence atomically.
  return {...base,action:'advance'};
 }
 if(ordered.some(([,r])=>['candidate_verified','unsubmitted_retired'].includes(r.state as string)))throw Error('Searching phase contradicts intent');
 if(seen.size===RANGES&&ordered.every(([,r])=>r.state==='range_complete'))return {...base,action:'domain_exhausted',reason:'All ranges have explicit no-hit CPU receipts; no solution implied'};
 const budget=s.budget as any;
 if(!budget||!Number.isSafeInteger(budget.deadlineMs)||!Number.isSafeInteger(budget.claimed)||budget.claimed<0||!Number.isSafeInteger(budget.maxSubmissions)||budget.maxSubmissions<1||budget.maxConcurrent!==1)throw Error('Invalid scheduler budget');
 if(now>=budget.deadlineMs||budget.claimed>=budget.maxSubmissions)return {...base,action:'budget_exhausted'};
 for(let n=0;n<RANGES;n++){
  const r=seen.get(n),intent=`RANGE#${s.stage}:${n}`;
  if(!r)return {...base,action:'reserve',intent};
  if(r.state==='reserved')return {...base,action:'submit',intent};
 }
 return {...base,action:'domain_exhausted',reason:'All ranges have explicit no-hit CPU receipts; no solution implied'};
}
