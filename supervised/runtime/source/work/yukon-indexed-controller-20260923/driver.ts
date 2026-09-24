/** Explicit bounded driver over guarded controller operations. No automatic error retries. */
import type {Plan} from './scheduler';
export interface DriverController {
 plan():Promise<Plan>;
 reserve(range:string,event:unknown):Promise<unknown>;
 submit(intent:string):Promise<unknown>;
 poll(intent:string):Promise<string>;
 retireUnsubmitted(intent:string):Promise<void>;
 advance():Promise<void>;
}
export type DriverOptions={maxOperations:number;deadlineMs:number;pollIntervalMs:number;signal?:AbortSignal};
export async function drive(c:DriverController,eventFor:(stage:string,attempt:number)=>Promise<unknown>,options:DriverOptions){
 const {maxOperations,deadlineMs,pollIntervalMs,signal}=options,start=Date.now(),mono=performance.now();
 if(!Number.isSafeInteger(maxOperations)||maxOperations<1||maxOperations>10000||!Number.isSafeInteger(deadlineMs)||deadlineMs<=start||deadlineMs>start+1800000||!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<100||pollIntervalMs>60000)throw Error('Invalid driver bounds');
 const expired=()=>Date.now()>=deadlineMs||performance.now()-mono>=deadlineMs-start;
 let operations=0;
 const summary=(reason:string,plan?:Plan)=>({reason,operations,...(plan?{plan}:{})});
 while(operations<maxOperations){
  if(signal?.aborted)return summary('aborted');
  if(expired())return summary('deadline');
  const p=await c.plan();
  if(signal?.aborted)return summary('aborted',p);
  if(expired())return summary('deadline',p);
  if(['reconcile','stopped','budget_exhausted','domain_exhausted'].includes(p.action))return summary(p.action,p);
  if(p.action==='advance'){await c.advance();operations++;continue;}
  const match=/^RANGE#(round[12]):(0|[1-9][0-9]*)$/.exec(p.intent??'');
  if(!match||match[1]!==p.stage)throw Error('Invalid planned intent');
  if(p.action==='reserve'){
   const event=await eventFor(p.stage,Number(match[2]));
   if(signal?.aborted)return summary('aborted',p);
   if(expired())return summary('deadline',p);
   await c.reserve(p.intent!.slice(6),event);
  }else if(p.action==='submit')await c.submit(p.intent!);
  else if(p.action==='retire')await c.retireUnsubmitted(p.intent!);
  else if(p.action==='poll'){
   const result=await c.poll(p.intent!);operations++;
   if(result==='paused')return summary('paused',p);
   if(result==='pending'&&operations<maxOperations&&!expired()&&!signal?.aborted){
    const ms=Math.min(pollIntervalMs,Math.max(0,deadlineMs-Date.now()),Math.max(0,deadlineMs-start-(performance.now()-mono)));
    await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,ms);signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();});
   }
   continue;
  }else throw Error('Unknown driver action');
  operations++;
 }
 return summary('operation_limit');
}
