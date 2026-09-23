import {publicVaultSchema,withdrawalSchema} from '../lib/model';import {assertVaultConfiguration,fingerprint} from '../lib/provenance';import {validateRequest} from './solvedContract';import type {retainedRequests} from './retainedRequest';
export const MAINNET_SEARCH_PROFILE='qsb-supervised-pin-v4-subset-v5' as const;
function freeze<T>(v:T):T{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
/** Public preparation only. Authenticated owner and the fixed profile come from application wiring. */
export function prepareMainnetSearchRequest(input:{owner:string;vault:unknown;manifest:unknown;wallet:{address:string;publicKey:string;type:string};releaseId:string}){
 const original=structuredClone(input),vault=publicVaultSchema.parse(original.vault),manifest=withdrawalSchema.parse(original.manifest);
 if(original.releaseId!==MAINNET_SEARCH_PROFILE||original.owner!==original.wallet.address||vault.paymentAddress!==original.owner||vault.network!=='mainnet'||vault.status!=='confirmed'||!vault.funding||fingerprint(vault.funding)!==fingerprint(manifest.funding))throw Error('Confirmed original mainnet owner, vault and route required.');assertVaultConfiguration(vault);
 const request=validateRequest({format:'qsb-mainnet-search-request-v1',network:'mainnet',genesisHash:'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',id:vault.id,vault,wallet:original.wallet,manifest});
 const body={manifest:request.manifest,execution:{releaseId:MAINNET_SEARCH_PROFILE},request};return freeze({owner:original.owner,request,body,requestHash:fingerprint(request),bodyHash:fingerprint(body)});
}
type Prepared=ReturnType<typeof prepareMainnetSearchRequest>;type Retention=Pick<ReturnType<typeof retainedRequests>,'retain'|'load'>;
/** Unmounted transport adapter; submit is trusted application wiring, never uploaded code or legacy /jobs. */
export function retainedMainnetSubmission(input:Prepared,retention:Retention,isCurrent:()=>boolean,submit:(body:Prepared['body'])=>Promise<unknown>){
 const prepared=structuredClone(input),validated=prepareMainnetSearchRequest({owner:prepared.owner,vault:prepared.request.vault,manifest:prepared.request.manifest,wallet:prepared.request.wallet,releaseId:prepared.body.execution.releaseId});if(fingerprint(validated)!==fingerprint(prepared))throw Error('Prepared request changed.');freeze(prepared);
 let state:'ready'|'retaining'|'submitting'|'settled'|'unknown'='ready';
 const current=()=>{if(!isCurrent()||fingerprint(input)!==fingerprint(prepared))throw Error('Wallet, session or original request changed.');};
 return {request:prepared.request,status:()=>state,async submit(){if(state!=='ready')throw Error('Submission already attempted; reconcile its exact job instead of retrying.');current();state='retaining';
  try{await retention.retain(prepared.request);current();const retained=retention.load(prepared.request.manifest.idempotencyKey,prepared.request.id,prepared.owner);if(fingerprint(retained)!==prepared.requestHash)throw Error('Original request retention differs.');current();}catch(error){state='ready';throw error;}
  state='submitting';try{const result=await submit(prepared.body);current();const job=(result as {job?:any})?.job;if(!job||job.id!==prepared.request.manifest.idempotencyKey||job.owner!==prepared.owner||job.vaultId!==prepared.request.id||fingerprint(job.manifest)!==fingerprint(prepared.request.manifest)||job.mainnetRequestHash!==prepared.requestHash||job.execution?.profile?.id!==MAINNET_SEARCH_PROFILE||job.execution?.network!=='mainnet')throw Error('Submission acknowledgement differs.');state='settled';return result;}catch{state='unknown';throw Error('Submission outcome unknown. Preserve the original request and reconcile this exact job; do not resubmit.');}
 }};
}
