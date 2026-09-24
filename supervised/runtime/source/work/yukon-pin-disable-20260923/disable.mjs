/** Lower only an enrolled, drained isolated endpoint. Caller must stop its dispatch first. */
import {ControlPlane} from '../yukon-indexed-controller-20260923/control-plane.mjs';
const REPO='UNENROLLED_REGISTRY/qsb-vault-worker@sha256:';
export async function disablePinnedEndpoint(expected,key,fetcher=fetch){
 const e=structuredClone(expected);
 if(!e||!e.image?.startsWith(REPO)||!/^[a-f0-9]{64}$/.test(e.image.slice(REPO.length)))throw Error('Pinned immutable image required');
 const api=new ControlPlane(key,e,fetcher),signal=AbortSignal.timeout(20000);
 const inspect=async()=>{const x=await api.inspect(e.id,signal);if(!x||x.image!==e.image||x.type!=='QUEUE'||x.workers?.min!==0||![0,1].includes(x.workers?.max))throw Error('Isolated endpoint binding differs');return x;};
 const health=async()=>{
  const r=await fetcher(`https://api.runpod.ai/v2/${e.id}/health`,{method:'GET',redirect:'error',signal,headers:{authorization:'Bearer '+key}});
  if(!r.ok){await r.body?.cancel();throw Error('Health unavailable');}
  const reader=r.body?.getReader();if(!reader)throw Error('Empty health');let size=0;const parts=[];
  for(;;){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>65536){await reader.cancel();throw Error('Oversized health');}parts.push(n.value);}
  const j=JSON.parse(Buffer.concat(parts).toString()).jobs;
  if(j?.inQueue!==0||j?.inProgress!==0)throw Error('Endpoint not drained');
 };
 try{
  const before=await inspect();await health();let patchSent=false;
  if(before.workers.max!==0){
   // No retries. An uncertain response requires a subsequent read/reconciliation.
   patchSent=true;const r=await fetcher(`https://api.runpod.io/v2/serverless/${e.id}`,{method:'PATCH',redirect:'error',signal,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({workers:{min:0,max:0}})});
   await r.body?.cancel();if(r.status!==200)throw Error('Disable not acknowledged');
  }
  const after=await inspect();if(after.workers.max!==0)throw Error('Disable not confirmed');await health();
  return {format:'qsb-pin-disabled-v1',endpoint:e.id,createdAt:e.createdAt,image:e.image,workersMin:0,workersMax:0,queued:0,inProgress:0,observedAtMs:Date.now(),patchSent,terminalJobsProven:false,rangeCreditGranted:false};
 }catch{throw Error('Pin endpoint disable unconfirmed; preserve state and reconcile without paid retry');}
}
