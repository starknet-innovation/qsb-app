import {base64} from '@scure/base';
import {fingerprint} from '../lib/provenance';
import {validateMainnetIntent,approvalSchema} from './intent';
import {localAssemblyInput,validateRequest,validateSolvedState} from './solvedContract';
import type {browserLocalAssembly} from './assembly';
import type {chainCheckedSigning} from './flow';
type HostProps={assembly:ReturnType<typeof browserLocalAssembly>;lock:()=>void;flow:ReturnType<typeof chainCheckedSigning>;signPsbt:(address:string,psbt:string,indices:number[])=>Promise<string>};
export type TrustedAdmissionReader=(requestId:string)=>Promise<{bundle:unknown;record:{bundleSha256:string};mainnetAuthorized:false}>;
export type Dependencies=Pick<HostProps,'assembly'|'lock'|'flow'|'signPsbt'>&{readCurrentAdmission:TrustedAdmissionReader};
function need(x:unknown,m:string):asserts x{if(!x)throw Error(m);}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
/** Bind caller-retained request to a current trusted service read. Uploaded digest/authority flags are never accepted. */
export async function bindSolvedConsumer(originalRequest:unknown,uploadedSolvedState:unknown,previous:{fundingPreviousTxHex:string;helperPreviousTxHex:string},deps:Dependencies,isLifetimeCurrent:()=>boolean=()=>true){
 const request=freeze(validateRequest(structuredClone(originalRequest))),bundle=freeze(validateSolvedState(structuredClone(uploadedSolvedState)));
 const originalHash=fingerprint(request),bundleHash=fingerprint(bundle),prev=freeze(structuredClone(previous));
 need(fingerprint(bundle.request)===originalHash,'Original retained request differs');
 need(Object.keys(prev).sort().join(',')==='fundingPreviousTxHex,helperPreviousTxHex'&&Object.values(prev).every(x=>typeof x==='string'&&/^(?:[a-f0-9]{2})+$/i.test(x)),'Exact public previous transactions required');
 const wallet=freeze({address:request.wallet.address,publicKey:request.wallet.publicKey});let generation=0;let disposed=false,contractHash:string|undefined,preparedPsbt:string|undefined;
 const originalStillCurrent=()=>{need(!disposed&&isLifetimeCurrent(),'Consumer disposed or superseded');need(fingerprint(validateRequest(originalRequest))===originalHash&&fingerprint(validateSolvedState(uploadedSolvedState))===bundleHash&&fingerprint(previous)===fingerprint(prev),'Public input changed');};
 async function current(){originalStillCurrent();const admitted=await deps.readCurrentAdmission(request.id);originalStillCurrent();
  need(admitted?.mainnetAuthorized===false&&admitted.record?.bundleSha256===bundleHash&&fingerprint(validateSolvedState(admitted.bundle))===bundleHash,'Current trusted admission differs');
  return localAssemblyInput(bundle,request,admitted.record.bundleSha256);
 }
 const bound=await current();
 const input=freeze({format:'qsb-mainnet-local-assembly-v1',vault:bound.vault,manifest:bound.manifest,solution:bound.solution,...prev,wallet});const inputHash=fingerprint(input);
 async function assembly(reimport:boolean,args:any[]){const epoch=++generation;contractHash=undefined;preparedPsbt=undefined;const [i,w,...rest]=args;const snapshot=structuredClone(i),walletSnapshot=structuredClone(w);need(fingerprint(snapshot)===inputHash&&fingerprint(walletSnapshot)===fingerprint(wallet),'Assembly input/wallet differs');
  try{await current();const result=await (reimport?deps.assembly.reimport(snapshot,walletSnapshot,rest[0],rest[1],rest[2]):deps.assembly.prepare(snapshot,walletSnapshot,rest[0],rest[1]));await current();need(epoch===generation,'Assembly superseded');need(fingerprint(i)===inputHash&&fingerprint(w)===fingerprint(wallet),'Assembly caller changed');
   if(result.kind==='ready'){need(reimport,'Reimport is mandatory');const parsed=validateMainnetIntent(result.contract);const c=parsed.contract;need(fingerprint(c.manifest)===fingerprint(input.manifest)&&c.vaultScriptHex===input.vault.scriptHex&&c.sequence===input.solution.sequence&&c.locktime===input.solution.locktime&&c.helperPublicKey===wallet.publicKey&&c.helperAddress===wallet.address&&c.fundingPreviousTxHex===prev.fundingPreviousTxHex&&c.helperPreviousTxHex===prev.helperPreviousTxHex,'Assembled contract differs');contractHash=parsed.intentHash;}
   return result;
  }catch(e){contractHash=undefined;preparedPsbt=undefined;deps.lock();throw e;}
 }
 const assertContract=(c:unknown)=>{need(contractHash&&validateMainnetIntent(c).intentHash===contractHash,'Reimported contract required');};
 const flow:HostProps['flow']={prepare:async(c,a)=>{const epoch=++generation;assertContract(c);const approval=approvalSchema.parse(structuredClone(a));need(approval.intentHash===contractHash,'Exact approval differs');preparedPsbt=undefined;await current();const out=await deps.flow.prepare(c,approval);const bytes=new Uint8Array(out.psbt);await current();need(epoch===generation,'Approval superseded');assertContract(c);need(out.intentHash===contractHash,'Prepared intent differs');preparedPsbt=base64.encode(bytes);return {...out,psbt:bytes};},accept:async(c,a,p)=>{assertContract(c);await current();const out=await deps.flow.accept(c,a,p);await current();assertContract(c);return out;}};
 return {input,solvedStateHash:bundleHash,assembly:{prepare:(...a:Parameters<HostProps['assembly']['prepare']>)=>assembly(false,a),reimport:(...a:Parameters<HostProps['assembly']['reimport']>)=>assembly(true,a)} as HostProps['assembly'],flow,
 signPsbt:async(address:string,psbt:string,indices:number[])=>{const epoch=generation,intent=contractHash,capability=preparedPsbt;preparedPsbt=undefined;need(contractHash&&capability&&address===wallet.address&&capability===psbt&&indices.length===1&&indices[0]===0,'Exact one-use prepared transaction and wallet required');const selected=[...indices];await current();need(epoch===generation&&intent===contractHash,'Signing superseded');const result=await deps.signPsbt(address,psbt,selected);await current();need(epoch===generation&&intent===contractHash,'Signing superseded');return result;},
 dispose:()=>{disposed=true;generation++;contractHash=undefined;preparedPsbt=undefined;deps.lock();},assertCurrent:current};
}
