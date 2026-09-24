import {signingReservations} from '../yukon-service-solved-completion-20260923/reservations';
import {originalRequest,capability,runtimeConfig} from './capability';
import type {Config} from '../yukon-mainnet-cycling-runner-20260923/transport';
import {canonicalOutpointKey,reservationAuthority} from '../yukon-canonical-reservations-20260923/reservations';
/** Isolated API-side service boundary. No endpoint, provider, infrastructure or production edits. */
import {createHash} from 'node:crypto';
import {withdrawalSchema} from '../../../../src/lib/model';
import {Conflict,type Store,type Row} from '../../../../server/store';
import {fingerprint} from '../../../../src/lib/provenance';
import {pinNewSupervisedJob,routeStoredJob} from '../yukon-app-routing-20260923/routing';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export type PublicValidator=(owner:string,vault:any,manifest:any)=>Promise<void>;
/** owner is authenticated middleware identity, not a body field. Validator retains existing chain/address/value checks. */
export async function createExplicitJob(store:Store,owner:string,body:unknown,validate:PublicValidator){
 const authority=await reservationAuthority(store),authorityHash=fingerprint(authority);
 const input=structuredClone(body) as any;if(!input||Object.keys(input).sort().join(',')!=='execution,manifest,request')throw Error('Exact explicit request required');
 const manifest=withdrawalSchema.parse(input.manifest),pk='OWNER#'+owner,sk='JOB#'+manifest.idempotencyKey,manifestHash=hash(JSON.stringify(manifest));
 const vaultRow=await store.get(pk,'VAULT#'+manifest.vaultId);if(!vaultRow)throw Error('Vault not found');const vault=structuredClone(vaultRow.vault) as any;
 const execution=pinNewSupervisedJob(input.execution,owner,vault,manifest);const mainnetRequest=originalRequest(input.request,{owner,id:manifest.idempotencyKey,vaultId:manifest.vaultId,manifest},vault),mainnetRequestHash=fingerprint(mainnetRequest);
 const existing=await store.get(pk,sk);
 if(existing){const job=existing.job as any;if(job.reservationAuthorityHash!==authorityHash)throw Error('Job belongs to a different reservation authority');if(job.mainnetRequestHash!==mainnetRequestHash||job.manifestHash!==manifestHash||fingerprint(job.execution)!==fingerprint(execution))throw Error('Idempotency key belongs to another withdrawal or route');routeStoredJob(job,vault);return {created:false,job};}
 if(manifest.helper.txid.toLowerCase()===manifest.funding.txid.toLowerCase()&&manifest.helper.vout===manifest.funding.vout)throw Error('Duplicate outpoint');
 await validate(owner,structuredClone(vault),structuredClone(manifest));
 const now=new Date().toISOString(),job={id:manifest.idempotencyKey,owner,vaultId:manifest.vaultId,manifest,manifestHash,execution,mainnetRequest,mainnetRequestHash,reservationAuthorityHash:authorityHash,createdAt:now,updatedAt:now,status:'queued',stage:'pinning',attempt:0,computeSeconds:0,revision:0};
 try{await store.atomicPut([{row:{pk,sk,version:0,job}},...['funding','helper'].map(key=>{const point=manifest[key as 'funding'|'helper'];return{row:{pk:canonicalOutpointKey(point.txid,point.vout),sk:'RESERVATION',version:0,owner,jobId:job.id}};}),{row:vaultRow,expected:vaultRow.version},{row:authority,expected:authority.version}]);}
 catch(error){if(!(error instanceof Conflict))throw error;const raced=await store.get(pk,sk);if(raced&&(raced.job as any).reservationAuthorityHash===authorityHash&&(raced.job as any).mainnetRequestHash===mainnetRequestHash&&(raced.job as any).manifestHash===manifestHash&&fingerprint((raced.job as any).execution)===fingerprint(execution)){routeStoredJob(raced.job as any,vault);return{created:false,job:raced.job};}throw error;}
 return{created:true,job};
}
export type LaunchRequest={owner:string;jobId:string;jobRowVersion:number;executionHash:string;invocationId:string};
export type Launcher=(request:LaunchRequest)=>Promise<{accepted:true;invocationId:string;executionHash:string}>;
/** launch is a future trusted fixed service transport. This source is not a deployed or enabled service. */
export async function dispatchExplicitJob(store:Store,owner:string,jobId:string,config:Config,launch:Launcher){
 const authority=await reservationAuthority(store),authorityHash=fingerprint(authority);
 const pk='OWNER#'+owner,jobKey='JOB#'+jobId,receiptKey='V5_INVOCATION#'+jobId;
 const row=await store.get(pk,jobKey);if(!row)throw Error('Job not found');const job=structuredClone(row.job) as any;
 if(job.reservationAuthorityHash!==authorityHash)throw Error('Reservation authority changed');
 if(job.owner!==owner||job.id!==jobId||job.status!=='queued'||job.revision!==0)throw Error('New queued explicit job required');
 const vaultRow=await store.get(pk,'VAULT#'+job.vaultId);if(!vaultRow)throw Error('Vault not found');
 const route=routeStoredJob(job,vaultRow.vault as any);if(route.target!=='supervised-service')throw Error('Historical job cannot use supervised launch');
 // Explicit trusted mainnet capability and checked original request/config are mandatory.
 if(route.execution.network!=='mainnet')throw Error('Explicit mainnet route required');const cap=await capability(store),reserved=await signingReservations(store,owner,job);if(fingerprint(originalRequest(job.mainnetRequest,job,vaultRow.vault))!==job.mainnetRequestHash)throw Error('Stored original request differs');
 const executionHash=fingerprint(route.execution),configured=runtimeConfig(config,owner,hash(pk+':'+jobKey+':'+fingerprint(route.execution))),prior=await store.get(pk,receiptKey);
 function matches(r:Row){return r.runtimeConfigHash===fingerprint(configured)&&r.mainnetRequestHash===job.mainnetRequestHash&&r.owner===owner&&r.jobId===jobId&&r.executionHash===executionHash&&r.invocationId===hash(pk+':'+jobKey+':'+executionHash);}
 if(prior){if(!matches(prior))throw Error('Invocation binding differs');return {receipt:prior,launched:false};}
 const invocationId=hash(pk+':'+jobKey+':'+executionHash),request={owner,jobId,jobRowVersion:row.version+1,executionHash,invocationId};
 const claim:Row={pk,sk:receiptKey,version:1,status:'dispatching',capabilityHash:fingerprint(cap),runtimeConfig:configured,runtimeConfigHash:fingerprint(configured),mainnetRequestHash:job.mainnetRequestHash,owner,jobId,executionHash,invocationId,request:JSON.stringify(request)};
 try{await store.atomicPut([{row:{...row,version:row.version+1},expected:row.version},{row:vaultRow,expected:vaultRow.version},{row:authority,expected:authority.version},{row:cap,expected:cap.version},...reserved.reservations.map(row=>({row,expected:row.version})),{row:claim}]);}
 catch(error){if(!(error instanceof Conflict))throw error;const raced=await store.get(pk,receiptKey);if(!raced||!matches(raced))throw error;return{receipt:raced,launched:false};}
 let acknowledgement;
 try{acknowledgement=await launch(structuredClone(request));if(acknowledgement?.accepted!==true||acknowledgement.invocationId!==invocationId||acknowledgement.executionHash!==executionHash)throw Error('Unbound launch acknowledgement');}
 catch(_error){try{await store.put({...claim,version:2,status:'unknown'},1);}catch{/* Original claim is durable and blocks any replay. */}throw Error('Launch outcome unknown; preserve invocation and reconcile');}
 const accepted={...claim,version:2,status:'accepted',acknowledgement:structuredClone(acknowledgement)};
 // A lost acknowledgement here leaves dispatching or accepted; both block duplicate launch.
 await store.put(accepted,1);return{receipt:accepted,launched:true};
}
