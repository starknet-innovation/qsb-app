import {z} from 'zod';
import {hex} from '@scure/base';
import {sha256} from '@noble/hashes/sha2.js';
import {publicVaultSchema,withdrawalSchema,validatePublicState} from '../lib/model';
import {assertVaultConfiguration,fingerprint} from '../lib/provenance';
import {decryptRecovery,encryptRecovery,assertRecoveryAuthorization,bindRecoveryAssembly,assertRecoveryAssembly} from '../lib/backup';
import {assembleQsb,validateRecovery,lockQsb} from '../lib/qsb';
import {validateMainnetIntent} from './intent';
const indices=z.array(z.number().int().min(0).max(149)).length(9).refine(x=>new Set(x).size===9);
const schema=z.object({format:z.literal('qsb-mainnet-local-assembly-v1'),vault:publicVaultSchema,manifest:withdrawalSchema,solution:z.object({sequence:z.number().int().min(0).max(0xffffffff),locktime:z.number().int().min(0).max(0xffffffff),round1:indices,round2:indices}).strict(),fundingPreviousTxHex:z.string(),helperPreviousTxHex:z.string(),wallet:z.object({address:z.string(),publicKey:z.string()}).strict()}).strict();
const digest=(s:string)=>hex.encode(sha256(new TextEncoder().encode(s)));
type Guard={claim:(key:string,value:string)=>void};
type Local={validate:typeof validateRecovery;assemble:typeof assembleQsb;lock:typeof lockQsb};
/** Trusted test seam for the local QSB worker only; crypto backup functions remain real. */
export function localAssembly(guard:Guard,local:Local){
 let busy=false;
 async function run(input:unknown,wallet:{address:string;publicKey:string},backup:string,password:string,expected?:string){
  if(busy)throw Error('Assembly already active');busy=true;
  try{
   const b=schema.parse(input),binding=fingerprint(b),walletBinding=fingerprint(wallet);
   if(b.vault.network!=='mainnet'||b.vault.id!==b.manifest.vaultId||b.vault.paymentAddress!==wallet.address||fingerprint(b.wallet)!==walletBinding)throw Error('Mainnet vault/wallet mismatch');
   validatePublicState(b.vault.publicStateJson);assertVaultConfiguration(b.vault);
   if(b.vault.status!=='confirmed'||!b.vault.funding||fingerprint(b.vault.funding)!==fingerprint(b.manifest.funding))throw Error('Vault funding mismatch');
   if(expected!==undefined&&backup!==expected)throw Error('Reimport the exact downloaded signing backup');
   const original=await decryptRecovery(backup,password);
   const immutable=(v:typeof b.vault)=>({id:v.id,network:v.network,config:v.config,scriptHex:v.scriptHex,scriptHash:v.scriptHash,publicStateJson:v.publicStateJson,paymentAddress:v.paymentAddress});
   assertVaultConfiguration(original.vault);
   if(original.vault.status==='spent'||fingerprint(immutable(original.vault))!==fingerprint(immutable(b.vault))||(original.vault.funding&&fingerprint(original.vault.funding)!==fingerprint(b.manifest.funding))||(await local.validate(original.stateJson))!==b.vault.scriptHash)throw Error('Recovery commitments differ');
   const manifestJson=JSON.stringify(b.manifest),manifestHash=digest(manifestJson);
   await assertRecoveryAuthorization(original,manifestHash);
   guard.claim(`qsb-intent:${b.vault.scriptHash}`,manifestHash);
   const recovery={...original,authorization:{...original.authorization,manifestJson,manifestHash}};
   const raw=await local.assemble(recovery.stateJson,b.manifest,b.solution);
   const contract=validateMainnetIntent({format:'qsb-mainnet-signing-intent-v1',network:'mainnet',genesisHash:'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',manifest:b.manifest,assembledTxHex:raw,fundingPreviousTxHex:b.fundingPreviousTxHex,helperPreviousTxHex:b.helperPreviousTxHex,vaultScriptHex:b.vault.scriptHex,helperPublicKey:b.wallet.publicKey,helperAddress:b.wallet.address,sequence:b.solution.sequence,locktime:b.solution.locktime}).contract;
   const bound=await bindRecoveryAssembly(recovery,b.solution,raw);
   guard.claim(`qsb-assembly:${b.vault.scriptHash}`,bound.authorization!.assembly!.rawTxHash);
   const unchanged=()=>{if(fingerprint(schema.parse(input))!==binding||fingerprint(wallet)!==walletBinding)throw Error('Input or wallet changed during assembly');};unchanged();
   if(expected!==undefined){await assertRecoveryAssembly(original,b.solution,raw);unchanged();return {kind:'ready' as const,contract};}
   const encryptedSigningBackup=await encryptRecovery(bound,password);unchanged();
   return {kind:'sealed' as const,id:b.vault.id,encryptedSigningBackup,manifestHash,rawTxHash:bound.authorization!.assembly!.rawTxHash};
  }finally{local.lock();busy=false;}
 }
 return {prepare:(i:unknown,w:{address:string;publicKey:string},b:string,p:string)=>run(i,w,b,p),reimport:(i:unknown,w:{address:string;publicKey:string},b:string,e:string,p:string)=>run(i,w,b,p,e)};
}
/** Browser host must wrap this lifecycle in wallet-event invalidation and explicit download/file selection. */
export function browserLocalAssembly(guard:Guard){return localAssembly(guard,{validate:validateRecovery,assemble:assembleQsb,lock:lockQsb});}
