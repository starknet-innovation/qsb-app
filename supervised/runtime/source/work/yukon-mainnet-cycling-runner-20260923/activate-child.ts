import type {Cpu} from './runtime-api';
import type {Store} from '../../outputs/qsb-vault/server/store';
import {canonical,fingerprint} from '../../outputs/qsb-vault/src/lib/provenance';
import {validateExecution,type Observation} from '../yukon-indexed-controller-20260923/execution-gate';
import {publicEventFactory} from './event-factory';
/** Bounded isolated activation; no provider calls, provisioning or production release. */
export async function activateSubsetChild(store:Store,parent:string,child:string,owner:string,revision:number,budget:{maxSubmissions:number;deadlineMs:number;submissionCutoffMs:number},observe:()=>Promise<Observation>,cpu:Cpu){
 if(![parent,child].every(x=>/^isolated-yukon-[a-z0-9-]+$/.test(x))||parent===child||!owner||!Number.isSafeInteger(revision)||revision<1)throw Error('Invalid isolated activation');
 budget=structuredClone(budget);
 const p=await store.get('VALIDATION#'+parent,'SCOPE'),c=await store.get('VALIDATION#'+child,'SCOPE');
 if(!p||!c||[p,c].some(x=>x.identitySchema!=='provider-index-v1'||x.identityConflict)||[p,c].some(x=>x.owner!==owner||x.revision!==revision)||p.phase!=='subset_linked'||p.childScope!==child||c.parentScope!==parent||c.phase!=='awaiting_activation'||c.stage!=='round1'||c.budget!==undefined||c.pinReceiptHash!==p.pinReceiptHash)throw Error('Unprepared or mismatched parent/child');
 if(!Number.isSafeInteger(budget.submissionCutoffMs)||budget.submissionCutoffMs<=Date.now()||budget.submissionCutoffMs>budget.deadlineMs)throw Error('Invalid submission cutoff');
  if(!Number.isSafeInteger(budget.maxSubmissions)||budget.maxSubmissions<1||budget.maxSubmissions>10000||!Number.isSafeInteger(budget.deadlineMs)||budget.deadlineMs<=Date.now()||budget.deadlineMs>Date.now()+1800000)throw Error('Invalid isolated budget');
 const inherited=p.inheritedSubsetBudget as any;if(inherited&&(!Number.isSafeInteger(inherited.claimed)||inherited.claimed<0||inherited.claimed>budget.maxSubmissions||inherited.maxSubmissions!==budget.maxSubmissions||inherited.deadlineMs!==budget.deadlineMs||inherited.submissionCutoffMs!==budget.submissionCutoffMs))throw Error('Cumulative subset budget changed');
 if((await store.list(c.pk,'RANGE#')).length)throw Error('Child already has work');
 const ctx=JSON.parse(p.publicContext as string);if(!['regtest','mainnet'].includes(ctx.network)||p.network!==ctx.network||c.network!==ctx.network)throw Error('Enrolled activation chain differs');
 const receipt=await cpu.pinHandoff({...ctx,candidate:structuredClone(p.pin)});
 if(receipt.referenceChecked!==true||receipt.dispatchAuthorized!==false||fingerprint(receipt)!==p.pinReceiptHash||canonical(receipt.pin)!==canonical(p.pin)||canonical(receipt.parameters)!==canonical(p.parameters))throw Error('CPU pin changed');
 const template=JSON.parse(c.template as string),expected={publicStateJson:ctx.publicStateJson,manifest:ctx.manifest,sequence:receipt.pin.sequence,locktime:receipt.pin.locktime,stage:'round1'};
 if(canonical(template.context)!==canonical(expected)||canonical({parameterBase64:template.request.parameterBase64,parameterSha256:template.request.parameterSha256})!==canonical(receipt.parameters.round1))throw Error('Child template changed');
 const {stage,...context}=template.context;
 if(fingerprint({context,runtimeHash:template.runtimeHash,solverId:template.request.solverId,solverReleaseHash:template.request.solverReleaseHash})!==c.publicBinding||c.adapterHash!=='f82d12eb4ef56db8d1a896572d6397d3cd9c167830c48abfa9fa184eb883274e')throw Error('Child runtime changed');
 const factory=publicEventFactory(template,cpu);
 for(const stage of ['round1','round2']){const event=await factory(stage,0);if(canonical({parameterBase64:event.request.parameterBase64,parameterSha256:event.request.parameterSha256})!==canonical(receipt.parameters[stage]))throw Error('Fresh CPU export differs from prepared parameters');} // Spent-context guard and real request validation.
 const observation=await observe();const execution=validateExecution(c.endpoint as string,budget.deadlineMs,observation);
 if(Date.now()>=budget.submissionCutoffMs)throw Error('Submission cutoff before activation');
 await store.atomicPut([{row:{...p,version:p.version+1,phase:'subset_running'},expected:p.version},{row:{...c,version:c.version+1,phase:'searching',dispatchAuthorized:true,budget:{...budget,claimed:inherited?.claimed??0,maxConcurrent:1},activation:execution},expected:c.version}]);
 return factory; // Each paid submit still rechecks live execution + durable dispatch fences.
}
