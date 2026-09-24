import type {Store,Row} from '../../outputs/qsb-vault/server/store';
import {createHash} from 'node:crypto';
const hash=(x:Uint8Array)=>createHash('sha256').update(x).digest('hex');
/** Atomic bounded chunks preserve provider evidence before parsing/CPU operations. */
export async function saveObservation(store:Store,scope:Row,intent:Row,value:unknown){
 const raw=Buffer.from(JSON.stringify(value));if(raw.length>2000000)throw Error('Oversized provider observation');
 const digest=hash(raw),parts:Row[]=[];
 for(let offset=0;offset<raw.length;offset+=180000){const sk=`OBS#${intent.sk}:${digest}:${parts.length}`;parts.push({pk:intent.pk,sk,version:1,data:raw.subarray(offset,offset+180000).toString('base64')});}
 const observation={sha256:digest,bytes:raw.length,parts:parts.map(x=>x.sk)};
 const nextScope={...scope,version:scope.version+1},nextIntent={...intent,version:intent.version+1,observation};
 const journal={pk:intent.pk,sk:`OBS_RECEIPT#${intent.sk}:${digest}`,version:1,observation};
 try{await store.atomicPut([{row:journal},...parts.map(row=>({row}))]);}catch(error){const saved=await store.get(journal.pk,journal.sk);if(!saved||JSON.stringify(saved.observation)!==JSON.stringify(observation))throw error;await readObservation(store,{...intent,observation});}
 // A stale scope cannot roll back the separate immutable evidence journal.
 await store.atomicPut([{row:nextScope,expected:scope.version},{row:nextIntent,expected:intent.version}]);
 return {scope:nextScope,intent:nextIntent};
}
export async function readObservation(store:Store,intent:Row){
 const o=intent.observation as any;
 if(!o||!Number.isSafeInteger(o.bytes)||o.bytes<1||o.bytes>2000000||!Array.isArray(o.parts)||o.parts.length<1||o.parts.length>12||new Set(o.parts).size!==o.parts.length||!(/^[a-f0-9]{64}$/).test(o.sha256))throw Error('Invalid saved observation');
 const buffers=[];
 for(let i=0;i<o.parts.length;i++){const sk=`OBS#${intent.sk}:${o.sha256}:${i}`;if(o.parts[i]!==sk)throw Error('Observation ownership mismatch');const row=await store.get(intent.pk,sk);if(!row||typeof row.data!=='string')throw Error('Missing observation chunk');const b=Buffer.from(row.data,'base64');if(b.length>180000||b.toString('base64')!==row.data)throw Error('Invalid chunk encoding');buffers.push(b);}
 const raw=Buffer.concat(buffers);if(raw.length!==o.bytes||hash(raw)!==o.sha256)throw Error('Observation digest mismatch');return JSON.parse(raw.toString('utf8'));
}
