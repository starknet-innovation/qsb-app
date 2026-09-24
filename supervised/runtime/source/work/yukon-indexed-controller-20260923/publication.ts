/** Isolated atomic publication; verify must be the trusted pinned CPU runtime. */
import {SCHEMA} from './identity-index';
import type {Store,Row} from '../../outputs/qsb-vault/server/store';
export type Verdict={decision:'range_complete'|'candidate_verified';referenceChecked:true;eligibleForRangeCredit:boolean;verdict:{valid?:boolean;indices?:number[]}};
export async function publish(store:Store,scope:string,owner:string,revision:number,sk:string,provider:string,output:unknown,verify:(frozen:unknown,output:unknown)=>Promise<Verdict>){
 if(!/^isolated-yukon-[a-z0-9-]+$/.test(scope))throw Error('Isolated scope required');
 const pk='VALIDATION#'+scope, intent=await store.get(pk,sk);
 if(!intent || intent.state!=='attached' || intent.provider!==provider || intent.owner!==owner || intent.revision!==revision)throw Error('Unattached or wrong-owner result');
 const result=await verify(JSON.parse(intent.frozen as string),structuredClone(output));
 if(result.referenceChecked!==true)throw Error('Missing CPU verification');
 const state=await store.get(pk,'SCOPE'), stage=sk.split(':')[0].replace('RANGE#','');
 if(!state || state.identitySchema!==SCHEMA || state.identityConflict || state.owner!==owner || state.revision!==revision || state.phase!=='searching' || state.stage!==stage)throw Error('Stale result');
 const index=await store.get(pk,'IDENTITY#'+sk);
 if(!index||index.schema!==SCHEMA||index.owner!==owner||index.revision!==revision||index.intent!==sk||index.count!==1||index.ambiguous||index.first!==provider||intent.identityConflict)throw Error('Unindexed or ambiguous publication');
 let next:Row={...state,version:state.version+1};
 if(result.decision==='range_complete' && result.eligibleForRangeCredit===true && result.verdict?.valid===false){
  const count=state.completedRanges ?? 0;if(!Number.isSafeInteger(count) || ((count as number)<0 || (count as number)>=Number.MAX_SAFE_INTEGER))throw Error('Invalid counter');
  next={...next,completedRanges:(count as number)+1};
 }else if(result.decision==='candidate_verified' && result.eligibleForRangeCredit===false && result.verdict.valid===true){
  const indices=result.verdict.indices;if(!indices || indices.length!==9 || new Set(indices).size!==9 || indices.some(x=>!Number.isInteger(x)||x<0||x>=150))throw Error('Invalid verified indices');
  next={...next,phase:'draining',solutions:{...(state.solutions as object ?? {}),[stage]:indices}};
 }else throw Error('Inconsistent receipt');
 await store.atomicPut([{row:{...index,version:index.version+1},expected:index.version},{row:next,expected:state.version},{row:{...intent,version:intent.version+1,state:result.decision,receipt:result},expected:intent.version}]);
 return result.decision;
}
