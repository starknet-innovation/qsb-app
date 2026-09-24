import {validateLineage} from './lineage';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {validateConfig,type Config} from '../yukon-common-operational-transport-20260923/transport';
import {ControlPlane} from '../yukon-indexed-controller-20260923/control-plane.mjs';
import type {CensusStore} from '../yukon-common-census-fence-20260923/census-store';
import {readObservation} from '../yukon-indexed-controller-20260923/observations';
const hash=(v:any)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const same=(a:any,b:any)=>isDeepStrictEqual(a,b);
const terminal=new Set(['COMPLETED','FAILED','CANCELLED','TIMED_OUT']);
/** Exact retained census is revalidated against the live store, never trusted as imported evidence. */
async function retained(store:CensusStore,c:Config,result:any){
 const s=result.snapshot,b=c.blueprint,run='SUPERVISION#'+b.runId;
 if(!s||s.runPk!==run||s.configHash!==hash(b)||hash(s)!==result.snapshotHash||![1,2].includes(s.scopes?.length))throw Error('Census binding differs');
 if(s.scopes.length===1&&(s.scopes[0].pk!=='VALIDATION#'+b.pin.parent||await store.get('VALIDATION#'+b.subset.scope,'SCOPE')))throw Error('Unexpected parent-only census');
 const marker=await store.get(run,'SHUTDOWN');if(!marker||marker.snapshotHash!==result.snapshotHash||marker.ownerVersion!==result.durableOwnerVersion)throw Error('Current shutdown differs');
 const owner=await store.get(run,'OWNER');if(!owner||owner.activeOperation!==null||owner.status!=='dispatch_stopped'||owner.version!==result.durableOwnerVersion)throw Error('Writer active');
 const lineage=await validateLineage(store,owner,run);const rows=await store.all(run);if(rows.length!==s.rows.length+1)throw Error('Writer census changed');
 for(const row of s.rows){const live=rows.find(x=>x.sk===row.sk);const expected={...row,...(['OWNER','RECOVERY_CONTROL'].includes(row.sk)?{version:row.version+1}:{})};if(!same(live,expected))throw Error('Writer row changed');}
 const reads:any[]=[];
 for(const scope of s.scopes){const live=await store.get(scope.pk,'SCOPE');if(!same(live,{...scope,version:scope.version+1})||live?.identityConflict)throw Error('Scope changed');reads.push(live);
  const intents=await store.list(scope.pk,scope.pk==='VALIDATION#'+b.pin.parent?'PIN#':'RANGE#');for(const i of intents){const binding=s.requestBindings.find((x:any)=>x.intent.pk===i.pk&&x.intent.sk===i.sk);if(i.provider!==undefined||i.state==='uncertain'){if(!binding)throw Error('Unregistered intent');}}
 }
 const known:any[]=[];const providers=new Set<string>();
 for(const binding of s.requestBindings){const i=binding.intent,[live,index,journals]=await Promise.all([store.get(i.pk,i.sk),store.get(i.pk,'IDENTITY#'+i.sk),store.list(i.pk,'PROVIDER_OBS#'+i.sk+':')]);if(!same(live,i)||!same(index,binding.index)||!same(journals,binding.journals))throw Error('Identity changed');
 const q=s.rows.find((r:any)=>r.sk===binding.request);if(!q)throw Error('Request missing');
 if(q.status==='not_sent'){const claims=(await Promise.all('0123456789abcdef'.split('').map(prefix=>store.list('VALIDATION#YUKON_PROVIDER_IDS',prefix)))).flat();if(claims.some(x=>x.scope===i.pk.slice(11)&&x.intent===i.sk))throw Error('Late no-send claim');if(i.provider!==undefined||index?.count!==0||journals.length)throw Error('Unknown no-send');continue;}
 if(q.status!=='resolved'||typeof i.provider!=='string'||q.providerId!==i.provider||index?.count!==1||index.first!==i.provider||index.ambiguous||journals.length!==1||journals[0].provider!==i.provider||providers.has(i.provider))throw Error('Unknown or ambiguous provider');providers.add(i.provider);
 const claim=await store.get('VALIDATION#YUKON_PROVIDER_IDS',hash(i.provider));if(!same(claim,binding.claim)||claim?.scope!==i.pk.slice(11)||claim?.intent!==i.sk)throw Error('Provider claim changed');
 const t=i.terminal??(i.observation?await readObservation(store,i):undefined);if(!t||t.id!==i.provider||!terminal.has(t.status))throw Error('No retained exact terminal observation');known.push({scope:i.pk,intent:i.sk,provider:i.provider,terminalHash:hash(t),status:t.status});
 }
 // Read original fences again after every inventory/observation read.
 for(const scope of s.scopes)if(!same(await store.get(scope.pk,'SCOPE'),{...scope,version:scope.version+1}))throw Error('Late scope writer');
 if(!same(await store.get(run,'OWNER'),owner)||!same(await store.get(run,'SHUTDOWN'),marker))throw Error('Late common writer');
 if(!same(lineage,await validateLineage(store,owner,run)))throw Error('Lineage changed');return{known,markerHash:hash(marker),inventoryHash:hash({rows,scopes:reads,known,lineage})};
}
async function health(endpoint:string,key:string,signal:AbortSignal){
 const r=await fetch(`https://api.runpod.ai/v2/${endpoint}/health`,{method:'GET',redirect:'error',signal,headers:{authorization:'Bearer '+key}});if(!r.ok)throw Error('Health unavailable');const reader=r.body?.getReader();if(!reader)throw Error('Health empty');let n=0;const chunks:Uint8Array[]=[];for(;;){const x=await reader.read();if(x.done)break;n+=x.value.length;if(n>65536){await reader.cancel();throw Error('Health oversized');}chunks.push(x.value);}const v=JSON.parse(Buffer.concat(chunks).toString());if(v?.jobs?.inQueue!==0||v?.jobs?.inProgress!==0)throw Error('Provider jobs not drained');return{queued:0,inProgress:0};
}
/** Private credential is runtime input only. No API call or credential lookup at construction. */
export function createFinalDrain(input:Config,key:string){const c=validateConfig(input);if(!key||/[\r\n]/.test(key))throw Error('Runtime credential missing');const clients={pin:new ControlPlane(key,c.pin),subset:new ControlPlane(key,c.subset)};
 return{async observe(store:CensusStore,result:any){const frozen=structuredClone(result),before=await retained(store,c,frozen),startedAt=Date.now();const endpoints=[];for(const stage of ['pin','subset'] as const){const expected=c[stage],signal=AbortSignal.timeout(4000),e=await clients[stage].inspect(expected.id,signal);if(!e||e.image!==expected.image||e.type!=='QUEUE'||e.workers?.min!==0||e.workers?.max!==0)throw Error('Owned endpoint still enabled or changed');const h=await health(expected.id,key,signal);endpoints.push({stage,id:e.id,createdAt:e.createdAt,image:e.image,workersMin:0,workersMax:0,...h,observedAt:Date.now()});}const after=await retained(store,c,frozen);if(!same(before,after))throw Error('Census changed during provider observation');return{format:'qsb-common-final-drain-v1',sourceHash:hash(readFileSync(new URL('./drain.ts',import.meta.url)).toString()),configHash:hash(c),censusHash:frozen.snapshotHash,inventoryHash:after.inventoryHash,markerHash:after.markerHash,knownTerminals:after.known,endpoints,startedAt,completedAt:Date.now(),sealEligible:false};}};
}
