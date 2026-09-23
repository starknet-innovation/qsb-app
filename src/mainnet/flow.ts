import * as btc from '@scure/btc-signer';
import {hex} from '@scure/base';
import {fingerprint} from '../lib/provenance';
import {MainnetEsplora} from './chain';
import {validateMainnetIntent,prepareApprovedMainnetPsbt,approvalSchema} from './intent';
import {finalizeMainnetHelper} from './finalizer';
type Reader=Pick<MainnetEsplora,'assertNetwork'|'unspent'>;
/** Only a trusted application constructor supplies reader; public JSON never selects network origin. */
export function chainCheckedSigning(reader:Reader){
 async function check(input:unknown,approval:unknown){
  const {contract,intentHash}=validateMainnetIntent(input),a=approvalSchema.parse(approval),approvalHash=fingerprint(a);
  prepareApprovedMainnetPsbt(contract,a); // Exact approval before any chain reads.
  const startedAt=new Date().toISOString();
  await reader.assertNetwork();
  const helperScript=hex.encode(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(contract.helperAddress)));
  const observations=[];
  for(const [point,script,raw] of [[contract.manifest.helper,helperScript,contract.helperPreviousTxHex],[contract.manifest.funding,contract.vaultScriptHex,contract.fundingPreviousTxHex]] as const){
   const observed=await reader.unspent({...point},script);
   if(observed.previousTxHex!==raw||!Number.isSafeInteger(observed.confirmations)||observed.confirmations<1)throw Error('Chain prevout observation differs from exact signing intent');
   observations.push({txid:point.txid,vout:point.vout,confirmations:observed.confirmations});
  }
  if(validateMainnetIntent(input).intentHash!==intentHash||fingerprint(approvalSchema.parse(approval))!==approvalHash)throw Error('Signing input changed during chain reads');
  return {contract,approval:a,intentHash,chainObservation:{startedAt,completedAt:new Date().toISOString(),observations,atomicSnapshot:false as const}};
 }
 return {
  async prepare(input:unknown,approval:unknown){const checked=await check(input,approval);return {...prepareApprovedMainnetPsbt(checked.contract,checked.approval),chainObservation:checked.chainObservation};},
  async accept(input:unknown,approval:unknown,returned:Uint8Array){
   const bytes=Uint8Array.from(returned); // Do not allow wallet bytes to change across chain awaits.
   const checked=await check(input,approval);
   if(hex.encode(returned)!==hex.encode(bytes))throw Error('Wallet result changed during chain reads');
   return {...finalizeMainnetHelper(checked.contract,checked.approval,bytes),chainObservation:checked.chainObservation};
  },
 };
}
/** Operational constructor; origin must be fixed by trusted app configuration, never intent input. */
export function mainnetSigningAtTrustedOrigin(origin:string){return chainCheckedSigning(new MainnetEsplora(origin));}
