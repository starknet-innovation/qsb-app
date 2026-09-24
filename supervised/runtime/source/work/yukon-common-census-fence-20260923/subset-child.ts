import type {Cpu} from './runtime-api';
/** Isolated bootstrap only. Creates an inert child; cannot authorize dispatch. */
import type {Store} from '../../outputs/qsb-vault/server/store';
import {canonical,fingerprint} from '../../outputs/qsb-vault/src/lib/provenance';
import {createHash} from 'node:crypto';
const RH='14ca2c729ecee121c715b7ff1acb9b8656b8650f8f4c02e3454c1067d22edeb9';
const SPENT=['historical-spent-fixture-0','historical-spent-fixture-1','historical-spent-fixture-2'];
const digest=(x:string)=>createHash('sha256').update(x).digest('hex');
export async function prepareSubsetChild(store:Store,parent:string,child:string,owner:string,revision:number,endpoint:string,cpu:Cpu){
 if(![parent,child].every(x=>/^isolated-yukon-[a-z0-9-]+$/.test(x))||parent===child||!owner||!Number.isSafeInteger(revision)||revision<1||!/^[a-z0-9]+$/.test(endpoint)||['historical-proof-disabled-a','historical-proof-disabled-b'].includes(endpoint))throw Error('Invalid isolated child binding');
 const pk='VALIDATION#'+parent,s=await store.get(pk,'SCOPE');
 if(!s||s.identitySchema!=='provider-index-v1'||s.identityConflict||s.owner!==owner||s.revision!==revision||s.phase!=='subset_prepared'||s.stage!=='round1'||s.childScope!==undefined||typeof s.publicContext!=='string')throw Error('Parent not prepared/current');
 if(SPENT.some(x=>(s.publicContext as string).toLowerCase().includes(x)))throw Error('Spent context cannot start a child');
 const ctx=JSON.parse(s.publicContext);
 const expectedHash=digest(canonical(ctx).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));
 if(s.publicContextHash!==expectedHash)throw Error('Parent public binding mismatch');
 // Re-run the actual pinned CPU verifier, never trust an imported receipt alone.
 const receipt=await cpu.pinHandoff({...ctx,candidate:structuredClone(s.pin)});
 if(receipt.runtimeHash!==RH||receipt.referenceChecked!==true||receipt.dispatchAuthorized!==false||receipt.publicContextHash!==expectedHash||canonical(receipt.pin)!==canonical(s.pin)||canonical(receipt.parameters)!==canonical(s.parameters)||fingerprint(receipt)!==s.pinReceiptHash)throw Error('Parent CPU binding mismatch');
 const context={publicStateJson:ctx.publicStateJson,manifest:ctx.manifest,sequence:receipt.pin.sequence,locktime:receipt.pin.locktime};
 const request={protocol:'qsb-config-a-v1',stage:'round1',...receipt.pin,attempt:0,manifestHash:digest(JSON.stringify(ctx.manifest)),kernelCommit:'1650caf53a32b0ea16aae9e490ebbf5a8686d632',searchVersion:'ranked-v2',solverId:'qsb-subset-tailcache-exact-owned-cleanup-v5',solverReleaseHash:'966136928aca1b7546275599a0462a1870c92b2a8d184391967a250bb16d9291',...receipt.parameters.round1};
 const event={action:'verify',runtimeHash:RH,context:{...context,stage:'round1'},request};
 const publicBinding=fingerprint({context,runtimeHash:RH,solverId:request.solverId,solverReleaseHash:request.solverReleaseHash});
 const target={identitySchema:'provider-index-v1',pk:'VALIDATION#'+child,sk:'SCOPE',version:1,owner,revision,phase:'awaiting_activation',stage:'round1',endpoint,adapterHash:'f82d12eb4ef56db8d1a896572d6397d3cd9c167830c48abfa9fa184eb883274e',publicBinding,parentScope:parent,pinReceiptHash:s.pinReceiptHash,template:JSON.stringify(event),dispatchAuthorized:false};
 await store.atomicPut([{row:{...s,version:s.version+1,phase:'subset_linked',childScope:child},expected:s.version},{row:target}]);
 return event;
}
