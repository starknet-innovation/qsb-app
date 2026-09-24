/** Trusted control-plane observations; consistency checks are not hardware attestation. */
export const MANIFEST='sha256:b2252456a01e4c33ff3298b8f34711a11a96d8dadc3511dc4060d7dede3495bf';
const REPO='UNENROLLED_REGISTRY/qsb-vault-worker';
const TAG=REPO+':ranked-v2';
// Watchdog deadline triggers cleanup; reserve its bounded ~19 s retry window.
export const CLEANUP_MARGIN_MS=20000;
export type Observation={observedAtMs:number;endpoint:any;allEndpoints:any[];pods:any[];inventoryComplete:boolean;registry?:{image:string;immutable:boolean;amd64Manifest:string};watchdog:{endpoint:string;live:boolean;deadlineMs:number;handle:string}};
export function validateExecution(endpoint:string,deadlineMs:number,o:Observation,now=Date.now()){
 if(!o||!Number.isSafeInteger(o.observedAtMs)||o.observedAtMs>now||now-o.observedAtMs>5000)throw Error('Stale control-plane observation');
 const e=o.endpoint,w=o.watchdog;
 if(!e||e.id!==endpoint||e.type!=='QUEUE'||e.workers?.min!==0||e.workers?.max!==1||e.gpu?.count!==1)throw Error('Unexpected endpoint capacity/type');
 if(['historical-proof-disabled-a','historical-proof-disabled-b'].includes(endpoint))throw Error('Spent endpoint');
 const created=Date.parse(e.createdAt);
 if(!Number.isFinite(created)||created>now||!Number.isSafeInteger(deadlineMs)||deadlineMs<=now||deadlineMs>created+1800000)throw Error('Invalid test deadline');
 if(!w||w.endpoint!==endpoint||w.live!==true||!w.handle||!Number.isSafeInteger(w.deadlineMs)||w.deadlineMs<deadlineMs||w.deadlineMs>created+1800000-CLEANUP_MARGIN_MS)throw Error('No live bounded deletion watchdog');
 if(e.image!==REPO+'@'+MANIFEST){if(e.image!==TAG||o.registry?.image!==TAG||o.registry.immutable!==true||o.registry.amd64Manifest!==MANIFEST)throw Error('Image identity mismatch');}
 if(e.requestUrls?.run!==`https://api.runpod.ai/v2/${endpoint}/run`)throw Error('Unexpected invoke URL');
 if(o.inventoryComplete!==true||!Array.isArray(o.allEndpoints)||!Array.isArray(o.pods)||o.pods.length!==0)throw Error('Unreconciled provider inventory');
 const ids=new Set<string>();let max=0;
 for(const x of o.allEndpoints){if(typeof x.id!=='string'||ids.has(x.id)||x.workers?.min!==0||!Number.isSafeInteger(x.workers?.max)||x.workers.max<0)throw Error('Invalid provider inventory');ids.add(x.id);if(x.workers.max>0&&(!Number.isSafeInteger(x.gpu?.count)||x.gpu.count<1))throw Error('Unknown GPU count');max+=x.workers.max*(x.gpu?.count??1);
  if(['historical-proof-disabled-a','historical-proof-disabled-b'].includes(x.id)&&x.workers.max!==0)throw Error('Spent proof capacity enabled');
 }
 if(!ids.has('historical-proof-disabled-a')||!ids.has('historical-proof-disabled-b'))throw Error('Incomplete proof endpoint inventory');
 const entry=o.allEndpoints.find(x=>x.id===endpoint);if(!entry||entry.workers.max!==1||max>10)throw Error('Provider capacity limit');
 return {endpoint,imageManifest:MANIFEST,observedAtMs:o.observedAtMs,watchdogHandle:w.handle,deadlineMs};
}
