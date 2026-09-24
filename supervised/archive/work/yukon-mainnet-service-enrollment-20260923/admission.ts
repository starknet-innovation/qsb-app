import {signingReservations} from '../yukon-service-solved-completion-20260923/reservations';
import {enrolledMainnet} from './capability';
import {createHash} from 'node:crypto';
import {Conflict,type Store} from '../../../../server/store';
import {fingerprint} from '../../../../src/lib/provenance';
import {routeStoredJob} from '../yukon-app-routing-20260923/routing';
import {reservationAuthority} from '../yukon-canonical-reservations-20260923/reservations';
import type {LaunchRequest} from './dispatch';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Trusted service ingress only. An admission is not authority for an unfenced later paid submission. */
export async function admitInvocation(store:Store,authenticatedOwner:string,input:LaunchRequest){
 const r=structuredClone(input);
 if(!r||Object.keys(r).sort().join(',')!=='executionHash,invocationId,jobId,jobRowVersion,owner'||r.owner!==authenticatedOwner||!authenticatedOwner||!Number.isSafeInteger(r.jobRowVersion)||r.jobRowVersion<1)throw Error('Invalid service invocation');
 const pk='OWNER#'+authenticatedOwner,jobKey='JOB#'+r.jobId,receiptKey='V5_INVOCATION#'+r.jobId,key='V5_ADMISSION#'+r.jobId;
 if(r.invocationId!==hash(pk+':'+jobKey+':'+r.executionHash))throw Error('Invocation identity differs');
 const prior=await store.get(pk,key);
 if(prior){if(prior.requestHash!==fingerprint(r))throw Error('Admission identity differs');return {created:false,admission:prior};}
 const jobRow=await store.get(pk,jobKey),receipt=await store.get(pk,receiptKey);
 if(!jobRow||!receipt)throw Error('Durable invocation required');
 const job=jobRow.job as any;
 const authority=await reservationAuthority(store);if(job.reservationAuthorityHash!==fingerprint(authority))throw Error('Reservation authority changed');
 if(jobRow.version!==r.jobRowVersion||job.owner!==r.owner||job.id!==r.jobId||job.status!=='queued'||job.revision!==0)throw Error('Stale or stopped job');
 let storedRequest:unknown;try{storedRequest=JSON.parse(String(receipt.request));}catch{throw Error('Malformed durable invocation');}
 if(fingerprint(storedRequest)!==fingerprint(r)||receipt.owner!==r.owner||receipt.jobId!==r.jobId||receipt.invocationId!==r.invocationId||receipt.executionHash!==r.executionHash||!['dispatching','unknown','accepted'].includes(String(receipt.status)))throw Error('Invocation receipt differs');
 const vaultRow=await store.get(pk,'VAULT#'+job.vaultId);if(!vaultRow)throw Error('Vault missing');
 const route=routeStoredJob(job,vaultRow.vault as any);
 if(route.target!=='supervised-service'||route.execution.network!=='mainnet'||fingerprint(route.execution)!==r.executionHash)throw Error('Unsupported or changed execution');
 const reserved=await signingReservations(store,authenticatedOwner,job);
 const enrollment=await enrolledMainnet(store,authenticatedOwner,job,receipt,vaultRow.vault);
 const admission={pk,sk:key,version:0,requestHash:fingerprint(r),request:r,status:'admitted',mainnetRequestHash:job.mainnetRequestHash,runtimeConfigHash:receipt.runtimeConfigHash,capabilityHash:receipt.capabilityHash,jobVersion:jobRow.version+1,executionHash:r.executionHash};
 try{await store.atomicPut([...reserved.reservations.map(row=>({row,expected:row.version})),{row:enrollment.capability,expected:enrollment.capability.version},{row:authority,expected:authority.version},{row:admission},{row:{...jobRow,version:jobRow.version+1,job:{...job,status:'starting'}},expected:jobRow.version},{row:receipt,expected:receipt.version},{row:vaultRow,expected:vaultRow.version}]);}
 catch(e){if(!(e instanceof Conflict))throw e;const raced=await store.get(pk,key);if(!raced||raced.requestHash!==admission.requestHash)throw e;return {created:false,admission:raced};}
 return {created:true,admission};
}
