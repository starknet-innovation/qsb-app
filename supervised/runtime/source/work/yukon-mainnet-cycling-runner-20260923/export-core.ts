/** Isolated linked-state exporter. No network submission, signing or secret access. */
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import type {Store,Row} from '../../outputs/qsb-vault/server/store';
import {canonical,fingerprint} from '../../outputs/qsb-vault/src/lib/provenance';
import {validateRequest,validateSolvedState,RELEASE as DESCRIPTOR} from './contract';
import type {Cpu} from './runtime-api';
import {savedTerminal} from '../yukon-indexed-controller-20260923/observations';
const RH='14ca2c729ecee121c715b7ff1acb9b8656b8650f8f4c02e3454c1067d22edeb9';
const RELEASE='966136928aca1b7546275599a0462a1870c92b2a8d184391967a250bb16d9291';
const ADAPTER='f82d12eb4ef56db8d1a896572d6397d3cd9c167830c48abfa9fa184eb883274e';
const SPENT=['historical-spent-fixture-3','historical-spent-fixture-0','historical-spent-fixture-1','historical-spent-fixture-2'];
const hash=(x:string)=>createHash('sha256').update(x).digest('hex');
const ascii=(x:unknown)=>canonical(x).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function need(x:unknown,msg:string):asserts x {if(!x)throw Error(msg);}
export type Config={parent:string;child:string;owner:string;revision:number};
export type DrainEvidence={observedAtMs:number;endpoints:{id:string;workersMin:0;workersMax:0;inQueue:0;inProgress:0}[]};
export type Dependencies={pin:Cpu['pinHandoff'];subset:Cpu['subset']};
// Required trusted owned CPU interface: no untracked process fallback.
/** observeDrain must be trusted live read-only provider adapter, not imported user JSON. */
export async function prepareExport(store:Store,c:Config,request:any,deps:Dependencies){
 c=structuredClone(c);request=validateRequest(request);
 need([c.parent,c.child].every(x=>/^isolated-yukon-[a-z0-9-]+$/.test(x))&&c.parent!==c.child&&c.owner&&Number.isSafeInteger(c.revision)&&c.revision>0,'Invalid scope');
 need(!SPENT.some(x=>JSON.stringify(request).toLowerCase().includes(x)),'Spent proof cannot produce a signing bundle');
 const parent=await store.get('VALIDATION#'+c.parent,'SCOPE'),child=await store.get('VALIDATION#'+c.child,'SCOPE');
 need(parent&&child,'Missing linked scope');


 for(const s of [parent,child])need(s.owner===c.owner&&s.revision===c.revision&&s.identitySchema==='provider-index-v1'&&!s.identityConflict,'Unindexed, stale, quarantined or previously exported scope');
 need(parent.phase==='subset_prepared'&&parent.childScope===c.child&&child.parentScope===c.parent&&child.phase==='awaiting_authorization'&&child.stage==='round2'&&parent.pinReceiptHash===child.pinReceiptHash,'Not drained linked final state');
 const context=JSON.parse(parent.publicContext as string);
 need(context.network==='mainnet'&&parent.network==='mainnet'&&child.network==='mainnet'&&hash(ascii(context))===parent.publicContextHash,'Public context mismatch');
 const manifest=context.manifest;
 need(context.publicStateJson===request.vault.publicStateJson&&same(manifest,request.manifest),'Original request/context mismatch');
 const pin=await deps.pin({...context,candidate:parent.pin});
 need(pin.runtimeHash===RH&&pin.referenceChecked===true&&pin.dispatchAuthorized===false&&pin.consensusVerified===false&&same(pin.pin,parent.pin)&&pin.publicContextHash===parent.publicContextHash&&same(pin.parameters,parent.parameters)&&fingerprint(pin)===parent.pinReceiptHash,'Fresh CPU pin mismatch');
 const inventories:any[]=[];const winners:Row[]=[];
 for(const [scope,prefix] of [[parent,'PIN#'],[child,'RANGE#']] as const){
  const rows=(await store.list(scope.pk,prefix)).sort((a,b)=>a.sk.localeCompare(b.sk));need(rows.length>0,'Empty inventory');
  for(const row of rows){
   need(row.owner===c.owner&&row.revision===c.revision&&!row.identityConflict&&!row.providerConflict&&!row.reconciliationRequired,'Wrong or ambiguous intent');
   const index=await store.get(scope.pk,'IDENTITY#'+row.sk);
   need(index&&index.schema==='provider-index-v1'&&index.owner===c.owner&&index.revision===c.revision&&index.intent===row.sk&&!index.ambiguous,'Missing identity fence');
   if(row.state==='unsubmitted_retired'&&!row.provider){need(index.count===0&&index.first===undefined&&(await store.list(scope.pk,'PROVIDER_OBS#'+row.sk+':')).length===0,'Retired identity mismatch');inventories.push({row,index});continue;}
   need(['pin_verified','candidate_verified','range_complete','attached'].includes(row.state as string)&&typeof row.provider==='string'&&index.count===1&&index.first===row.provider,'Unresolved identity');
   const journal=await store.get(scope.pk,'PROVIDER_OBS#'+row.sk+':'+hash(row.provider));
   const journals=await store.list(scope.pk,'PROVIDER_OBS#'+row.sk+':');need(journals.length===1,'Ambiguous provider journals');
   const claim=await store.get('VALIDATION#YUKON_PROVIDER_IDS',hash(row.provider));
   need(journal&&journal.schema==='provider-index-v1'&&journal.provider===row.provider&&journal.intent===row.sk&&journal.owner===c.owner&&journal.revision===c.revision&&claim&&claim.scope===scope.pk.slice(11)&&claim.intent===row.sk&&claim.provider===row.provider,'Identity journal/claim mismatch');
   const t=row.terminal as any;need(t&&t.id===row.provider&&['COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(t.status)&&Number.isFinite(Date.parse(t.observedAt)),'Sibling terminal evidence missing');
   inventories.push({row,index,journal,claim});
   if(row.state==='pin_verified')need(t.status==='COMPLETED'&&same(row.receipt,pin),'Pin receipt mismatch');
   if(row.state==='candidate_verified'){need(t.status==='COMPLETED','Candidate not completed');winners.push(row);}
  }
 }
 need(inventories.some(x=>x.row.pk===parent.pk&&x.row.state==='pin_verified'),'Missing pin winning intent');
 const solutions=child.solutions as any;const verified:any={};
 for(const stage of ['round1','round2']){
  const matched=winners.filter(r=>r.sk.startsWith('RANGE#'+stage+':')&&same((r.receipt as any)?.verdict?.indices,solutions?.[stage]));need(matched.length===1,'Missing/ambiguous candidate winner');
  const row=matched[0],event=JSON.parse(row.frozen as string),output=await savedTerminal(store,row);
  need(event.action==='verify'&&event.runtimeHash===RH&&event.request.solverReleaseHash===RELEASE&&event.request.solverId==='qsb-subset-tailcache-exact-owned-cleanup-v5'&&event.request.stage===stage&&same(event.context,{publicStateJson:context.publicStateJson,manifest,...pin.pin,stage})&&same({parameterBase64:event.request.parameterBase64,parameterSha256:event.request.parameterSha256},pin.parameters[stage]),'Candidate context/release mismatch');
  const transport=output?.output?.transport;
  need(output?.id===row.provider&&output.status==='COMPLETED'&&transport?.providerJobId===row.provider&&transport.adapterSha256===ADAPTER&&transport.inputSha256===hash(ascii({action:'compute',runtimeHash:RH,request:event.request})),'Saved provider output binding mismatch');
  const verdict=await deps.subset({...event,output:output.output.runtime});
  need(verdict.runtimeHash===RH&&verdict.referenceChecked===true&&verdict.decision==='candidate_verified'&&verdict.eligibleForRangeCredit===false&&verdict.verdict?.valid===true&&same(verdict.verdict.indices,solutions[stage]),'Fresh CPU subset mismatch');verified[stage]=verdict;
 }
 const bundle=validateSolvedState({format:'qsb-mainnet-solved-state-v1',network:'mainnet',request,solution:{...pin.pin,round1:solutions.round1,round2:solutions.round2},release:DESCRIPTOR});
 const snapshot={parent,child,inventories,pin,verified,requestSha256:hash(ascii(request)),bundle};
 const currentParent=await store.get(parent.pk,'SCOPE'),currentChild=await store.get(child.pk,'SCOPE');
 need(same(currentParent,parent)&&same(currentChild,child),'Linked state changed during verification');
 // Re-read the exact evidence inventory, including additions, after CPU and drain awaits.
 const refreshed:any[]=[];
 for(const [scope,prefix] of [[parent,'PIN#'],[child,'RANGE#']] as const){
  for(const row of (await store.list(scope.pk,prefix)).sort((a,b)=>a.sk.localeCompare(b.sk))){
   const index=await store.get(scope.pk,'IDENTITY#'+row.sk);
   if(row.state==='unsubmitted_retired'&&!row.provider){refreshed.push({row,index});continue;}
   need(typeof row.provider==='string','Changed provider identity');
   const journals=await store.list(scope.pk,'PROVIDER_OBS#'+row.sk+':');need(journals.length===1,'Changed provider journals');
   refreshed.push({row,index,journal:await store.get(scope.pk,'PROVIDER_OBS#'+row.sk+':'+hash(row.provider)),claim:await store.get('VALIDATION#YUKON_PROVIDER_IDS',hash(row.provider))});
  }
 }
 need(same(refreshed,inventories),'Export evidence changed during verification');
 const snapshotHash=fingerprint(snapshot),receipt={format:'qsb-prepared-mainnet-solved-state-v1',snapshotHash,bundleSha256:fingerprint(bundle),runtimeHash:RH,solverReleaseHash:RELEASE,adapterSha256:ADAPTER,mainnetAuthorized:false,operationalExportEnabled:false,status:'PREPARED',source:'linked-indexed-parent-child'};
 return {bundle,receipt,snapshot};
}
