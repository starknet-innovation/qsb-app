import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Store,Row} from '../../outputs/qsb-vault/server/store';
import {fingerprint} from '../../outputs/qsb-vault/src/lib/provenance';
import {pinRange} from '../yukon-pin-adapter-20260923/adapter';
import {SCHEMA} from '../yukon-indexed-controller-20260923/identity-index';
import {expectedRange,RANGES,DOMAIN} from '../yukon-indexed-controller-20260923/scheduler';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export type Binding={parent:string;child:string;nextParent:string;runPk:string;owner:string;revision:number;configHash:string};
export type SettledProof={format:'qsb-context-retirement-proof-v1';binding:Binding;parentVersion:number;childVersion:number;ownerVersion:number;writersSettled:true;dispatchClosed:true;endpoints:{id:string;min:0;max:0;queued:0;inProgress:0}[];observedAtMs:number};
/** Private trusted reader contract; public config cannot supply code or self-attested proof. */
export type ProofReader=(binding:Binding)=>Promise<SettledProof>;
function budget(v:any){if(!v||!Number.isSafeInteger(v.claimed)||v.claimed<0||!Number.isSafeInteger(v.maxSubmissions)||v.claimed>v.maxSubmissions||!Number.isSafeInteger(v.deadlineMs)||!Number.isSafeInteger(v.submissionCutoffMs)||v.submissionCutoffMs>v.deadlineMs||v.maxConcurrent!==1)throw Error('Invalid cumulative budget');return structuredClone(v);}
async function terminalInventory(store:Store,s:Row,prefix:string){
 const rows=await store.list(s.pk,prefix),indices=new Map((await store.list(s.pk,'IDENTITY#')).map(r=>[r.sk,r])),journals=await store.list(s.pk,'PROVIDER_OBS#');
 const byIntent=new Map<string,Row[]>();for(const j of journals){const a=byIntent.get(String(j.intent))??[];a.push(j);byIntent.set(String(j.intent),a);} if(indices.size!==rows.length||[...byIntent.keys()].some(k=>!rows.some(r=>r.sk===k)))throw Error('Orphan identity evidence');
 for(const r of rows){
  if(r.owner!==s.owner||r.revision!==s.revision||r.identityConflict)throw Error('Invalid intent owner or conflict');
  const i=indices.get('IDENTITY#'+r.sk),js=byIntent.get(r.sk)??[];
  if(!i||i.schema!==SCHEMA||i.intent!==r.sk||i.owner!==r.owner||i.revision!==r.revision||i.ambiguous)throw Error('Unindexed intent');
  if(r.state==='unsubmitted_retired'&&!r.provider){if(i.count!==0||i.first!==undefined||js.length)throw Error('Retired intent has identity');continue;}
  if(!['range_complete','candidate_verified','pin_verified','candidate'].includes(String(r.state))||typeof r.provider!=='string'||i.count!==1||i.first!==r.provider||js.length!==1)throw Error('Unresolved sibling');
  const j=js[0],t=r.terminal as any;
  if(j.sk!=='PROVIDER_OBS#'+r.sk+':'+sha(r.provider)||j.provider!==r.provider||j.schema!==SCHEMA||j.owner!==r.owner||j.revision!==r.revision||!t||!Number.isFinite(Date.parse(t.observedAt))||t.id!==r.provider||!['COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(t.status))throw Error('Missing exact terminal identity');
  const claim=await store.get('VALIDATION#YUKON_PROVIDER_IDS',sha(r.provider));
  if(!claim||claim.provider!==r.provider||claim.scope!==s.pk.slice(11)||claim.intent!==r.sk)throw Error('Global identity mismatch');
 }
 return rows;
}
export async function prepareNextContext(store:Store,input:Binding,readProof:ProofReader){
 const b=structuredClone(input);
 if(![b.parent,b.child,b.nextParent].every(x=>/^isolated-yukon-[a-z0-9-]+$/.test(x))||new Set([b.parent,b.child,b.nextParent]).size!==3||!b.runPk.startsWith('SUPERVISION#'))throw Error('Invalid context binding');
 const [p,c,o]=await Promise.all([store.get('VALIDATION#'+b.parent,'SCOPE'),store.get('VALIDATION#'+b.child,'SCOPE'),store.get(b.runPk,'OWNER')]);
 if(!p||!c||!o||[p,c].some(s=>s.identitySchema!==SCHEMA||s.identityConflict||s.owner!==b.owner||s.revision!==b.revision||s.supervisedRun!==b.runPk||s.supervisedConfigHash!==b.configHash)||o.owner!==b.owner||o.revision!==b.revision||o.configHash!==b.configHash||o.status!=='owned'||o.activeOperation!==null||o.lifecycle!=='subset')throw Error('Not current idle indexed owner');
 if(p.phase!=='subset_running'||p.childScope!==b.child||c.parentScope!==b.parent||c.pinReceiptHash!==p.pinReceiptHash||typeof p.pinReceiptHash!=='string'||c.phase!=='searching'||!['round1','round2'].includes(String(c.stage)))throw Error('Context linkage or stage mismatch');
 const pb=budget(p.budget),cb=budget(c.budget),solutions=c.solutions as any;
 if(solutions?.[String(c.stage)]||(c.stage==='round1'&&solutions&&Object.keys(solutions).length)||(c.stage==='round2'&&(!Array.isArray(solutions?.round1)||solutions.round1.length!==9)))throw Error('Invalid exhausted-stage solution state');
 const pinRows=await terminalInventory(store,p,'PIN#'),subsetRows=await terminalInventory(store,c,'RANGE#');
 const wins=pinRows.filter(r=>r.state==='pin_verified'&&fingerprint(r.receipt)===p.pinReceiptHash);
 if(wins.length!==1||!isDeepStrictEqual((wins[0].receipt as any)?.pin,p.pin)||(wins[0].receipt as any)?.referenceChecked!==true)throw Error('Missing bound verified pin');
 const attempts=pinRows.map(r=>{if(!/^PIN#(0|[1-9][0-9]*)$/.test(r.sk))throw Error('Invalid pin attempt');return Number(r.sk.slice(4));}).sort((a,b)=>a-b);
 const floor=Number(p.pinResumeFloor??0);if(!Number.isSafeInteger(floor)||floor<0||!attempts.length||attempts.some((n,i)=>n!==floor+i))throw Error('Pin history has a gap');
 for(const r of pinRows){const n=Number(r.sk.slice(4)),v=r.receipt as any;if(r.state==='range_complete'&&(v?.kind!=='no_hits'||!Array.isArray(v.pins)||v.pins.length||!isDeepStrictEqual(v.range,pinRange(n))||(r.terminal as any)?.status!=='COMPLETED'))throw Error('Unproven prior pin coverage');if(r!==wins[0]&&r.state!=='range_complete')throw Error('Unsettled or skipped pin range');}
 const resume=attempts.at(-1)!+1;if(resume>=2**27)throw Error('Pin domain exhausted');
 const stage=String(c.stage),stageRows=subsetRows.filter(r=>r.sk.startsWith('RANGE#'+stage+':'));
 if(stageRows.length!==RANGES||subsetRows.some(r=>!/^RANGE#round[12]:(0|[1-9][0-9]*)$/.test(r.sk)))throw Error('Incomplete subset domain');
 const seen=new Set<number>();for(const r of stageRows){const n=Number(r.sk.split(':')[1]),v=r.receipt as any,w=expectedRange(n);if(seen.has(n)||r.state!=='range_complete'||(r.terminal as any)?.status!=='COMPLETED'||v?.decision!=='range_complete'||v.referenceChecked!==true||v.eligibleForRangeCredit!==true||v.verdict?.valid!==false||!isDeepStrictEqual(v.workRange,w))throw Error('Unproven full no-hit domain');seen.add(n);}
 const proof=structuredClone(await readProof(structuredClone(b)));
 if(proof.format!=='qsb-context-retirement-proof-v1'||!isDeepStrictEqual(proof.binding,b)||proof.parentVersion!==p.version||proof.childVersion!==c.version||proof.ownerVersion!==o.version||proof.writersSettled!==true||proof.dispatchClosed!==true||!Number.isSafeInteger(proof.observedAtMs)||Math.abs(Date.now()-proof.observedAtMs)>30000||proof.endpoints.length!==2||new Set(proof.endpoints.map(e=>e.id)).size!==2||![p.endpoint,c.endpoint].every(id=>proof.endpoints.some(e=>e.id===id))||proof.endpoints.some(e=>e.min!==0||e.max!==0||e.queued!==0||e.inProgress!==0))throw Error('Unsettled retirement proof');
 const receipt={format:'qsb-context-retired-v1',binding:b,exhaustedStage:stage,domain:String(DOMAIN),ranges:RANGES,pinResumeFloor:resume,excludedPin:p.pin,previousResumeFloor:floor,sourceVersions:{parent:p.version,child:c.version,owner:o.version},pinInventoryHash:fingerprint(pinRows),subsetInventoryHash:fingerprint(subsetRows),proofHash:fingerprint(proof),budgets:{pin:pb,subset:cb}};
 const next:Row={pk:'VALIDATION#'+b.nextParent,sk:'SCOPE',version:1,identitySchema:SCHEMA,owner:b.owner,revision:b.revision,phase:'awaiting_context_activation',stage:'pinning',dispatchAuthorized:false,publicContext:p.publicContext,publicContextHash:p.publicContextHash,pinParameters:p.pinParameters,budget:pb,inheritedSubsetBudget:cb,pinResumeFloor:resume,excludedPin:p.pin,predecessorParent:b.parent,predecessorChild:b.child,retirementHash:fingerprint(receipt)};
 await store.atomicPut([{row:{...p,version:p.version+1,phase:'context_retired',dispatchClosed:true,nextContext:b.nextParent},expected:p.version},{row:{...c,version:c.version+1,phase:'context_retired',dispatchClosed:true,nextContext:b.nextParent},expected:c.version},{row:{...o,version:o.version+1,status:'context_retired',nextContext:b.nextParent},expected:o.version},{row:{pk:b.runPk,sk:'CONTEXT_RETIREMENT',version:1,...receipt}},{row:next}]);return {receipt,next};
}
/** Read-only eligibility/fence vector. Activator MUST CAS all returned rows; not launch permission. */
export async function retirementFences(store:Store,nextScope:string){
 const next=await store.get('VALIDATION#'+nextScope,'SCOPE');if(!next||next.phase!=='awaiting_context_activation'||next.dispatchAuthorized!==false||typeof next.predecessorParent!=='string'||typeof next.predecessorChild!=='string')throw Error('Not an inert context');
 const p=await store.get('VALIDATION#'+next.predecessorParent,'SCOPE'),c=await store.get('VALIDATION#'+next.predecessorChild,'SCOPE');if(!p||!c||typeof p.supervisedRun!=='string')throw Error('Missing predecessor');
 const o=await store.get(p.supervisedRun,'OWNER'),record=await store.get(p.supervisedRun,'CONTEXT_RETIREMENT');if(!o||!record)throw Error('Missing retirement authority');
 const {pk,sk,version,...receipt}=record,v=receipt.sourceVersions as any,b=receipt.binding as Binding;
 if(version!==1||fingerprint(receipt)!==next.retirementHash||b.nextParent!==nextScope||b.parent!==next.predecessorParent||b.child!==next.predecessorChild||b.runPk!==p.supervisedRun||p.version!==v.parent+1||c.version!==v.child+1||o.version!==v.owner+1||[p,c].some(s=>s.phase!=='context_retired'||s.identityConflict||s.nextContext!==nextScope)||o.status!=='context_retired'||o.nextContext!==nextScope||!isDeepStrictEqual(next.budget,(receipt.budgets as any).pin)||!isDeepStrictEqual(next.inheritedSubsetBudget,(receipt.budgets as any).subset)||next.pinResumeFloor!==receipt.pinResumeFloor)throw Error('Retirement invalidated; reconcile old context');
 return [p,c,o,record,next];
}
