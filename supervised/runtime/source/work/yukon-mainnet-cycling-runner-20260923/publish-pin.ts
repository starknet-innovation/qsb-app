import type {Cpu} from './runtime-api';
import {SCHEMA} from '../yukon-indexed-controller-20260923/identity-index';
import {assertIdentity} from '../yukon-indexed-pin-20260923/identity';
import type {Store} from '../../outputs/qsb-vault/server/store';
import {canonical,fingerprint} from '../../outputs/qsb-vault/src/lib/provenance';
import {createHash} from 'node:crypto';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
// Python's ASCII canonical JSON is used by the frozen public reference wrapper.
const contextHash=(x:unknown)=>hash(Buffer.from(canonical(x).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))));
/** Isolated pinning-drain schema; all inventory mutations MUST contend on SCOPE.version. */
export async function publishPin(store:Store,scope:string,owner:string,revision:number,winner:string,cpu:Cpu){
 if(!/^isolated-yukon-[a-z0-9-]+$/.test(scope)||!owner||!Number.isSafeInteger(revision)||revision<1)throw Error('Invalid ownership');
 const pk='VALIDATION#'+scope,s=await store.get(pk,'SCOPE');
 if(!s||s.identitySchema!==SCHEMA||s.identityConflict||s.owner!==owner||s.revision!==revision||s.phase!=='pinning_draining'||s.stage!=='pinning'||typeof s.publicContext!=='string')throw Error('Not current pin handoff');
 const ctx=JSON.parse(s.publicContext);if(contextHash(ctx)!==s.publicContextHash)throw Error('Context binding mismatch');
 const rows=await store.list(pk,'PIN#'),r=rows.find(x=>x.sk===winner);
 if(!r||r.state!=='candidate'||typeof r.provider!=='string'||!r.candidate)throw Error('Missing candidate provider');
 for(const row of rows){
  if(row.owner!==owner||row.revision!==revision)throw Error('Wrong sibling ownership');
  if(row.state==='unsubmitted_retired'&&!row.provider)continue;
  await assertIdentity(store,row);
  const t=row.terminal as any;
  if(!['candidate','attached','range_complete'].includes(row.state as string)||typeof row.provider!=='string'||!t||t.id!==row.provider||!['COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(t.status)||!Number.isFinite(Date.parse(t.observedAt)))throw Error('Unresolved sibling');
 }
 if((r.terminal as any).status!=='COMPLETED')throw Error('Winner not completed');
 const identity=await assertIdentity(store,r);
 const result=await cpu.pinHandoff({...ctx,candidate:structuredClone(r.candidate)});
 if(result.format!=='qsb-isolated-pin-handoff-v1'||result.runtimeHash!=='14ca2c729ecee121c715b7ff1acb9b8656b8650f8f4c02e3454c1067d22edeb9'||result.publicContextHash!==s.publicContextHash||result.referenceChecked!==true||result.dispatchAuthorized!==false||result.consensusVerified!==false||canonical(result.pin)!==canonical(r.candidate)||Object.keys(result.parameters??{}).sort().join(',')!=='round1,round2')throw Error('Invalid CPU handoff');
 for(const v of Object.values(result.parameters) as any[]){if(typeof v.parameterBase64!=='string'||typeof v.parameterSha256!=='string')throw Error('Invalid parameter bytes');const b=Buffer.from(v.parameterBase64,'base64');if(b.toString('base64')!==v.parameterBase64||hash(b)!==v.parameterSha256)throw Error('Parameter digest mismatch');}
 await store.atomicPut([{row:{...identity,version:identity.version+1},expected:identity.version},{row:{...s,version:s.version+1,stage:'round1',phase:'subset_prepared',pin:result.pin,parameters:result.parameters,pinReceiptHash:fingerprint(result)},expected:s.version},{row:{...r,version:r.version+1,state:'pin_verified',receipt:result},expected:r.version}]);
 return result;
}
