import * as btc from '@scure/btc-signer';
import {hex} from '@scure/base';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {validateMainnetIntent,prepareApprovedMainnetPsbt} from './intent';
const opts={allowUnknownInputs:true,allowUnknownOutputs:true};
const same=(a?:Uint8Array,b?:Uint8Array)=>hex.encode(a||new Uint8Array())===hex.encode(b||new Uint8Array());
function requireThat(ok:unknown,message:string):asserts ok{if(!ok)throw Error(message);}
/** No wallet calls or broadcast. Exact helper cryptography, not QSB consensus. */
export function finalizeMainnetHelper(input:unknown,approval:unknown,returned:Uint8Array){
 const {contract:c,intentHash}=validateMainnetIntent(input);
 const expected=btc.Transaction.fromPSBT(prepareApprovedMainnetPsbt(c,approval).psbt,opts);
 const actual=btc.Transaction.fromPSBT(returned,opts),pub=hex.decode(c.helperPublicKey);
 requireThat(same(actual.unsignedTx,expected.unsignedTx),'Wallet changed unsigned transaction');
 for(let i=0;i<2;i++){
  const a=actual.getInput(i),e=expected.getInput(i);
  requireThat(!!a.nonWitnessUtxo&&hex.encode(btc.RawTx.encode(a.nonWitnessUtxo))===hex.encode(btc.RawTx.encode(e.nonWitnessUtxo!)),'Previous transaction metadata changed');
  requireThat(!a.tapKeySig&&!a.tapScriptSig?.length&&!a.tapLeafScript?.length,'Unexpected Taproot metadata');
  if(i===1)requireThat(same(a.finalScriptSig,e.finalScriptSig)&&!a.finalScriptWitness?.length&&!a.partialSig?.length,'Wallet changed QSB authorization');
 }
 const before=actual.getInput(0),e=expected.getInput(0);
 requireThat(before.witnessUtxo?.amount===e.witnessUtxo?.amount&&same(before.witnessUtxo?.script,e.witnessUtxo?.script)&&(same(before.redeemScript,e.redeemScript)||(!before.redeemScript&&!!before.finalScriptWitness?.length)),'Helper metadata changed');
 requireThat(before.sighashType===undefined||before.sighashType===1,'Unexpected sighash');
 requireThat(!before.partialSig?.length||(before.partialSig.length===1&&same(before.partialSig[0][0],pub)),'Extraneous helper signatures');
 if(!before.finalScriptWitness?.length){requireThat(before.partialSig?.length===1,'Missing helper signature');actual.finalizeIdx(0);}
 const final=actual.getInput(0),w=final.finalScriptWitness;
 const native=btc.p2wpkh(pub,btc.NETWORK),script=c.helperAddress===native.address?new Uint8Array():btc.Script.encode([native.script]);
 requireThat(same(final.finalScriptSig,script)&&w?.length===2&&same(w[1],pub),'Invalid final helper witness/script');
 const sig=w![0];
 const digest=expected.preimageWitnessV0(0,btc.p2pkh(pub,btc.NETWORK).script,1,BigInt(c.manifest.helper.value));
 requireThat(sig.at(-1)===1&&secp256k1.verify(sig.slice(0,-1),digest,pub,{prehash:false,format:'der'}),'Invalid helper signature');
 if(before.partialSig?.length)requireThat(same(before.partialSig[0][1],sig),'Conflicting partial/final signature');
 requireThat(same(actual.getInput(1).finalScriptSig,expected.getInput(1).finalScriptSig),'QSB authorization changed during finalization');
 return {format:'qsb-mainnet-verified-helper-result-v1' as const,network:'mainnet' as const,intentHash,rawTxHex:hex.encode(actual.extract()),txid:actual.id,helperSignatureVerified:true as const,qsbConsensusProven:false as const,chainInclusionProven:false as const,broadcastAuthorized:false as const};
}
