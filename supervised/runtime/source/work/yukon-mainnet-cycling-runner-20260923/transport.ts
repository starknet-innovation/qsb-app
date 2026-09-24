import {disablePinnedEndpoint} from '../yukon-pin-disable-20260923/disable.mjs';
/** Fixed operational transport. Construction is offline; methods use real provider APIs. */
import {createHash} from 'node:crypto';
import {ProviderIO as Pin} from '../yukon-v4-controller-20260923/provider-io';
import {ProviderIO as Subset} from '../yukon-indexed-controller-20260923/provider-io';
import {ControlPlane} from '../yukon-indexed-controller-20260923/control-plane.mjs';
import {probeWatchdog} from '../yukon-indexed-controller-20260923/watchdog-client';
import {validateExecution as pinGate,MANIFEST as PIN} from '../yukon-pin-preflight-20260923/execution-gate';
import {validateExecution as subsetGate,MANIFEST as SUBSET} from '../yukon-indexed-controller-20260923/execution-gate';
import {createFixedCommon} from './fixed-common';
import type {CensusStore} from '../yukon-common-census-fence-20260923/census-store';
import type {Blueprint} from './common';
const REPO='UNENROLLED_REGISTRY/qsb-vault-worker';
const forbidden=['historical-proof-disabled-a','historical-proof-disabled-b'];
export type Config={format:'qsb-common-operational-v1';blueprint:Blueprint;pin:{id:string;createdAt:string;image:string;socket:string};subset:{id:string;createdAt:string;image:string;socket:string}};
const exact=(x:any,keys:string[])=>{if(!x||Object.keys(x).sort().join(',')!==keys.sort().join(','))throw Error('Unexpected configuration fields');};
export function validateConfig(input:Config){
 const c=structuredClone(input);exact(c,['format','blueprint','pin','subset']);if(!['regtest','mainnet'].includes(c.blueprint?.network)||c.format!=='qsb-common-operational-v1'||c.blueprint?.format!=='qsb-common-lifetime-v1')throw Error('Unexpected format');
 for(const [stage,digest] of [['pin',PIN],['subset',SUBSET]] as const){const cutoff=c.blueprint[stage].submissionCutoffMs;if(!Number.isSafeInteger(cutoff)||cutoff<0||cutoff>c.blueprint[stage].deadlineMs)throw Error('Invalid enrolled cutoff');const x=c[stage];exact(x,['id','createdAt','image','socket']);if(!/^[a-z0-9]+$/.test(x.id)||forbidden.includes(x.id)||x.id!==c.blueprint[stage].endpoint||!Number.isFinite(Date.parse(x.createdAt))||x.image!==REPO+'@'+digest||!/^\/[a-zA-Z0-9_./-]+$/.test(x.socket)||x.socket.includes('/../'))throw Error('Endpoint, image or watchdog binding differs');}
 if(c.pin.id===c.subset.id)throw Error('Distinct stage endpoints required');return c;
}
export function operationalTransports(input:Config,key:string){
 const c=validateConfig(input);if(!key||/[\r\n]/.test(key))throw Error('Runtime credential unavailable');
 const pin=new Pin(c.pin.id,`https://api.runpod.ai/v2/${c.pin.id}/run`,key),subset=new Subset(c.subset.id,`https://api.runpod.ai/v2/${c.subset.id}/run`,key);
 const pa=new ControlPlane(key,c.pin),sa=new ControlPlane(key,c.subset);
 async function observe(stage:'pin'|'subset'){
  const x=c[stage],api=stage==='pin'?pa:sa,started=Date.now(),signal=AbortSignal.timeout(4000),deadline=c.blueprint[stage].deadlineMs;
  const [endpoint,inventory,watchdog]=await Promise.all([api.inspect(x.id,signal),api.inventory(signal),probeWatchdog(x.socket,x.id,deadline)]);
  if(endpoint?.image!==x.image)throw Error('Immutable image changed');const o={observedAtMs:started,endpoint,...inventory,watchdog};(stage==='pin'?pinGate:subsetGate)(x.id,deadline,o);return o;
 }
 async function drain(){
  const started=Date.now(),signal=AbortSignal.timeout(4000),e=await pa.inspect(c.pin.id,signal);if(!e||e.image!==c.pin.image)throw Error('Parent endpoint identity unavailable');
  const response=await fetch(`https://api.runpod.ai/v2/${c.pin.id}/health`,{method:'GET',redirect:'error',signal,headers:{authorization:'Bearer '+key}});if(!response.ok)throw Error('Provider health unavailable');
  const reader=response.body?.getReader();if(!reader)throw Error('Provider health empty');const parts:Uint8Array[]=[];let size=0;for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>65536){await reader.cancel();throw Error('Provider health oversized');}parts.push(x.value);}
  const v=JSON.parse(Buffer.concat(parts).toString('utf8')),queued=v?.jobs?.inQueue,inProgress=v?.jobs?.inProgress;if(!Number.isSafeInteger(queued)||queued<0||!Number.isSafeInteger(inProgress)||inProgress<0)throw Error('Provider health malformed');return{observedAtMs:started,endpoint:c.pin.id,workersMin:e.workers.min,workersMax:e.workers.max,queued,inProgress};
 }
 return{pin,subset,observePin:()=>observe('pin'),observeSubset:()=>observe('subset'),drain,config:structuredClone(c),configHash:createHash('sha256').update(JSON.stringify(c)).digest('hex')};
}
/** No environment/key-file access, table creation, provisioning or executable callbacks. */
export function createOperationalCommon(store:CensusStore,config:Config,key:string,emit:(e:any)=>void,preserve:(e:any)=>Promise<void>,preserveCpu:(e:any)=>Promise<void>){const t=operationalTransports(config,key);return createFixedCommon(store,t.config.blueprint,t.pin,t.subset,t.observePin,t.observeSubset,t.drain,emit,preserve,preserveCpu,()=>disablePinnedEndpoint(t.config.pin,key));}
