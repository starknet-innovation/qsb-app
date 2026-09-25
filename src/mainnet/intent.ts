/** Public byte binding only. No signing, chain lookup, broadcast or enablement. */
import * as btc from '@scure/btc-signer';
import {hex} from '@scure/base';
import {z} from 'zod';
import {withdrawalSchema} from '../lib/model';
import {fingerprint} from '../lib/provenance';
const opts={allowUnknownInputs:true,allowUnknownOutputs:true};
const bytes=z.string().regex(/^(?:[a-f0-9]{2})+$/).max(8000000);
export const contractSchema=z.object({
 format:z.literal('qsb-mainnet-signing-intent-v1'), network:z.literal('mainnet'),
 genesisHash:z.literal('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'),
 manifest:withdrawalSchema, assembledTxHex:bytes,
 fundingPreviousTxHex:bytes, helperPreviousTxHex:bytes,
 vaultScriptHex:bytes.max(20000), helperPublicKey:bytes.max(66), helperAddress:z.string(),
 sequence:z.number().int().min(0).max(0xffffffff),locktime:z.number().int().min(0).max(0xffffffff),
}).strict();
export const approvalSchema=z.object({format:z.literal('qsb-mainnet-exact-approval-v1'),network:z.literal('mainnet'),intentHash:z.string().regex(/^[a-f0-9]{64}$/), action:z.literal('request-xverse-signature'),approved:z.literal(true)}).strict();
function requireThat(ok:unknown,message:string):asserts ok {if(!ok)throw Error(message);}
export function validateMainnetIntent(input:unknown){
 const c=contractSchema.parse(input),m=c.manifest;
 const tx=btc.Transaction.fromRaw(hex.decode(c.assembledTxHex),opts);
 requireThat(tx.version===1&&tx.lockTime===c.locktime&&tx.inputsLength===2&&tx.outputsLength===1,'Transaction layout mismatch');
 const pub=hex.decode(c.helperPublicKey),native=btc.p2wpkh(pub,btc.NETWORK),nested=btc.p2sh(native,btc.NETWORK);
 requireThat(c.helperAddress===native.address||c.helperAddress===nested.address,'Mainnet helper ownership mismatch');
 const helperScript=btc.OutScript.encode(btc.Address(btc.NETWORK).decode(c.helperAddress));
 for(const [i,p,raw,script] of [[0,m.helper,c.helperPreviousTxHex,hex.encode(helperScript)],[1,m.funding,c.fundingPreviousTxHex,c.vaultScriptHex]] as const){
  const prev=btc.Transaction.fromRaw(hex.decode(raw),opts),out=prev.getOutput(p.vout),actual=tx.getInput(i);
  requireThat(prev.id===p.txid.toLowerCase()&&out.amount===BigInt(p.value)&&!!out.script&&hex.encode(out.script)===script,'Previous output mismatch');
  requireThat(!!actual.txid&&hex.encode(actual.txid)===prev.id&&actual.index===p.vout&&actual.sequence===(i===0?0xfffffffe:c.sequence),'Input commitment mismatch');
 }
 requireThat(m.helper.txid.toLowerCase()!==m.funding.txid.toLowerCase()||m.helper.vout!==m.funding.vout,'Duplicate outpoint');
 const destination=btc.OutScript.encode(btc.Address(btc.NETWORK).decode(m.destination)),out=tx.getOutput(0);
 requireThat(hex.encode(destination)===m.outputScript.toLowerCase()&&!!out.script&&hex.encode(out.script)===hex.encode(destination)&&out.amount===BigInt(m.outputValue)&&out.amount>0n,'Destination/value mismatch');
 requireThat(BigInt(m.fee)>0n&&BigInt(m.helper.value)+BigInt(m.funding.value)-out.amount===BigInt(m.fee),'Fee mismatch');
 requireThat(!!tx.getInput(1).finalScriptSig?.length&&!tx.getInput(1).finalScriptWitness?.length,'Missing or unsupported QSB authorization');
 requireThat(!tx.getInput(0).finalScriptSig?.length&&!tx.getInput(0).finalScriptWitness?.length,'Helper already signed');
 return {contract:c,intentHash:fingerprint(c),chainInclusionProven:false as const,qsbConsensusProven:false as const,mainnetEnabled:false as const};
}
/** Approval must come from a separate explicit UI act; accepting this public object cannot authenticate a human. */
export function prepareApprovedMainnetPsbt(input:unknown,approval:unknown){
 const {contract:c,intentHash}=validateMainnetIntent(input),a=approvalSchema.parse(approval);
 requireThat(a.intentHash===intentHash,'Exact approval binding mismatch');
 const tx=btc.Transaction.fromRaw(hex.decode(c.assembledTxHex),opts),pub=hex.decode(c.helperPublicKey),w=btc.p2wpkh(pub,btc.NETWORK);
 tx.updateInput(0,{nonWitnessUtxo:hex.decode(c.helperPreviousTxHex),witnessUtxo:{amount:BigInt(c.manifest.helper.value),script:btc.OutScript.encode(btc.Address(btc.NETWORK).decode(c.helperAddress))},...(c.helperAddress===btc.p2sh(w,btc.NETWORK).address?{redeemScript:w.script}:{})},true);
 tx.updateInput(1,{nonWitnessUtxo:hex.decode(c.fundingPreviousTxHex)},true);
 return {psbt:tx.toPSBT(),intentHash,broadcastAuthorized:false as const};
}
/** Fields the approval screen shows. Validation failure must not render a partial intent. */
export function exactSigningIntentDisplay(input: unknown) {
  const validated = validateMainnetIntent(input);
  const manifest = validated.contract.manifest;
  return {
    ...validated,
    broadcastAuthorized: false as const,
    lines: [
      { label: "Chain", value: "Bitcoin mainnet" },
      {
        label: "Helper outpoint",
        value: `${manifest.helper.txid}:${manifest.helper.vout}`,
      },
      {
        label: "Funding outpoint",
        value: `${manifest.funding.txid}:${manifest.funding.vout}`,
      },
      { label: "Helper input (sats)", value: manifest.helper.value },
      { label: "Vault input (sats)", value: manifest.funding.value },
      { label: "Destination", value: manifest.destination },
      { label: "Output (sats)", value: manifest.outputValue },
      { label: "Fee (sats)", value: manifest.fee },
      { label: "Exact intent hash", value: validated.intentHash },
    ],
  };
}
