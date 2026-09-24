import type {Cpu} from './runtime-api';
/** Frozen public context; every stage's bytes come from the pinned CPU runtime. */
import {expectedRange} from '../yukon-indexed-controller-20260923/scheduler';
const SPENT=['historical-spent-fixture-0','historical-spent-fixture-1','historical-spent-fixture-2'];
export function publicEventFactory(template:unknown,cpu:Cpu){
 const text=JSON.stringify(template);
 if(!text||Buffer.byteLength(text)>200000||SPENT.some(x=>text.toLowerCase().includes(x)))throw Error('Invalid or spent public template');
 const frozen=JSON.parse(text);
 if(Object.keys(frozen).sort().join(',')!=='action,context,request,runtimeHash'||frozen.action!=='verify'||!frozen.context||!frozen.request)throw Error('Public verify template required');
 const stages=new Map<string,Promise<any>>();
 return async(stage:string,attempt:number)=>{
  if(!['round1','round2'].includes(stage))throw Error('Subset stage required');expectedRange(attempt);
  let pending=stages.get(stage);
  if(!pending){
   pending=(async()=>{
    const e=structuredClone(frozen);e.request.stage=stage;e.context.stage=stage;e.request.attempt=0;
    const exported=await cpu.subset({...e,action:'export'});
    if(exported.runtimeHash!==e.runtimeHash||typeof exported.parameterBase64!=='string'||typeof exported.parameterSha256!=='string')throw Error('Unexpected CPU export');
    e.request.parameterBase64=exported.parameterBase64;e.request.parameterSha256=exported.parameterSha256;
    return e;
   })();
   // Failed exports remain failed; no implicit process or transport retry.
   stages.set(stage,pending);
  }
  const event=structuredClone(await pending);event.request.attempt=attempt;return event;
 };
}
