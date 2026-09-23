import { BITCOIN_NETWORK } from "./network";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { withdrawalSchema, type Withdrawal, type Job } from "./model";
export type FundingInput = {
  txid: string;
  vout: number;
  value: bigint;
  previousTxHex: string;
  publicKey: string;
  address: string;
};
export function outputScript(address: string): Uint8Array {
  return btc.OutScript.encode(btc.Address(BITCOIN_NETWORK).decode(address));
}
const opts = { allowUnknownOutputs: true, allowUnknownInputs: true };
export function fundingPsbt(
  inputs: FundingInput[],
  scriptHex: string,
  amount: bigint,
  fee: bigint,
  changeAddress: string,
) {
  if (amount <= 0n || fee <= 0n)
    throw new Error("Amount and fee must be positive.");
  if (!inputs.length)
    throw new Error("Select at least one confirmed payment UTXO.");
  const script = hex.decode(scriptHex);
  if (script.length > 10000 || script.length < 100)
    throw new Error("Invalid QSB script.");
  const tx = new btc.Transaction({ ...opts, version: 2 });
  const seen = new Set<string>();
  let total = 0n;
  for (const input of inputs) {
    const key = `${input.txid}:${input.vout}`;
    if (seen.has(key)) throw new Error("Duplicate input.");
    seen.add(key);
    const raw = hex.decode(input.previousTxHex),
      prev = btc.Transaction.fromRaw(raw, opts);
    if (prev.id !== input.txid)
      throw new Error("Previous transaction ID mismatch.");
    const out = prev.getOutput(input.vout);
    const paymentScript = outputScript(input.address);
    if (
      out.amount !== input.value ||
      !out.script ||
      hex.encode(out.script) !== hex.encode(paymentScript)
    )
      throw new Error("Input amount or owner mismatch.");
    const pub = hex.decode(input.publicKey),
      wpkh = btc.p2wpkh(pub, BITCOIN_NETWORK),
      nested = btc.p2sh(wpkh, BITCOIN_NETWORK);
    if (input.address !== wpkh.address && input.address !== nested.address)
      throw new Error(
        "Only Xverse P2WPKH and nested SegWit payment inputs are supported.",
      );
    tx.addInput({
      txid: input.txid,
      index: input.vout,
      sequence: 0xfffffffe,
      nonWitnessUtxo: raw,
      witnessUtxo: { amount: input.value, script: paymentScript },
      ...(input.address === nested.address
        ? { redeemScript: wpkh.script }
        : {}),
    });
    total += input.value;
  }
  const change = total - amount - fee;
  if (change < 0n) throw new Error("Insufficient funds, including miner fee.");
  if (change > 0n && change < 546n)
    throw new Error("Change is too small. Adjust amount or inputs.");
  tx.addOutput({ amount, script });
  if (change > 0n) tx.addOutputAddress(changeAddress, change, BITCOIN_NETWORK);
  return tx;
}
export function verifySignedPsbt(
  expected: btc.Transaction,
  returned: Uint8Array,
) {
  const actual = btc.Transaction.fromPSBT(returned, opts);
  if (hex.encode(actual.unsignedTx) !== hex.encode(expected.unsignedTx))
    throw new Error("Wallet changed the transaction. Refusing to submit.");
  for (let i = 0; i < expected.inputsLength; i++) {
    const a = actual.getInput(i),
      e = expected.getInput(i);
    if (
      e.witnessUtxo &&
      (a.witnessUtxo?.amount !== e.witnessUtxo.amount ||
        hex.encode(a.witnessUtxo.script) !== hex.encode(e.witnessUtxo.script))
    )
      throw new Error("Wallet changed previous output metadata.");
    // unsignedTx omits finalized scripts. QSB authorization is already final
    // when input 0 is sent to Xverse, so compare input 1 explicitly as well.
    if (
      e.finalScriptSig?.length &&
      (!a.finalScriptSig ||
        hex.encode(a.finalScriptSig) !== hex.encode(e.finalScriptSig))
    )
      throw new Error("Wallet changed the QSB authorization.");
  }
  return actual;
}
export function helperPsbt(
  rawQsbTxHex: string,
  helper: FundingInput,
  qsbPreviousTxHex: string,
) {
  const tx = btc.Transaction.fromRaw(hex.decode(rawQsbTxHex), opts);
  if (tx.inputsLength !== 2 || tx.outputsLength !== 1)
    throw new Error("Expected a two-input QSB withdrawal.");
  const input = tx.getInput(0);
  if (
    !input.txid ||
    hex.encode(input.txid) !== helper.txid ||
    input.index !== helper.vout
  )
    throw new Error("Wrong helper input.");
  const prev = btc.Transaction.fromRaw(hex.decode(helper.previousTxHex), opts);
  if (
    prev.id !== helper.txid ||
    prev.getOutput(helper.vout).amount !== helper.value
  )
    throw new Error("Helper previous output mismatch.");
  const qsbPrev = btc.Transaction.fromRaw(hex.decode(qsbPreviousTxHex), opts),
    qsbInput = tx.getInput(1);
  if (!qsbInput.txid || hex.encode(qsbInput.txid) !== qsbPrev.id)
    throw new Error("QSB previous transaction mismatch.");
  const wpkh = btc.p2wpkh(hex.decode(helper.publicKey), BITCOIN_NETWORK);
  if (
    helper.address !== wpkh.address &&
    helper.address !== btc.p2sh(wpkh, BITCOIN_NETWORK).address
  )
    throw new Error("Unsupported helper payment key or address.");
  if (qsbInput.index === undefined || !qsbPrev.getOutput(qsbInput.index).script)
    throw new Error("QSB previous output missing.");
  if (!qsbInput.finalScriptSig?.length)
    throw new Error("QSB authorization is missing.");
  if (helper.txid === qsbPrev.id && helper.vout === qsbInput.index)
    throw new Error("Helper and QSB input must be different outputs.");
  const script = outputScript(helper.address);
  if (hex.encode(prev.getOutput(helper.vout).script!) !== hex.encode(script))
    throw new Error("Helper address mismatch.");
  tx.updateInput(
    0,
    {
      nonWitnessUtxo: hex.decode(helper.previousTxHex),
      witnessUtxo: { amount: helper.value, script },
      ...(helper.address === btc.p2sh(wpkh, BITCOIN_NETWORK).address
        ? { redeemScript: wpkh.script }
        : {}),
    },
    true,
  );
  tx.updateInput(1, { nonWitnessUtxo: hex.decode(qsbPreviousTxHex) }, true);
  return tx;
}

// Check the actual locally assembled bytes before revealing authorization to
// the wallet. A manifest hash alone does not establish what the assembler made.
export function verifyWithdrawalCommitment(
  rawHex: string,
  manifest: Withdrawal,
  solution: NonNullable<Job["solution"]>,
): void {
  withdrawalSchema.parse(manifest);
  const tx = btc.Transaction.fromRaw(hex.decode(rawHex), opts);
  const fail = () => {
    throw new Error("Assembled withdrawal differs from the approved intent.");
  };
  if (
    tx.version !== 1 ||
    tx.lockTime !== solution.locktime ||
    tx.inputsLength !== 2 ||
    tx.outputsLength !== 1
  )
    fail();
  for (const [index, point] of [manifest.helper, manifest.funding].entries()) {
    const input = tx.getInput(index);
    if (
      !input.txid ||
      hex.encode(input.txid) !== point.txid.toLowerCase() ||
      input.index !== point.vout ||
      input.sequence !== (index === 0 ? 0xfffffffe : solution.sequence)
    )
      fail();
  }
  const output = tx.getOutput(0);
  if (
    !output.script ||
    hex.encode(output.script) !== manifest.outputScript.toLowerCase() ||
    hex.encode(outputScript(manifest.destination)) !==
      manifest.outputScript.toLowerCase() ||
    output.amount !== BigInt(manifest.outputValue) ||
    output.amount <= 0n ||
    BigInt(manifest.fee) <= 0n ||
    BigInt(manifest.helper.value) +
      BigInt(manifest.funding.value) -
      output.amount !==
      BigInt(manifest.fee)
  )
    fail();
  if (
    manifest.helper.txid.toLowerCase() ===
      manifest.funding.txid.toLowerCase() &&
    manifest.helper.vout === manifest.funding.vout
  )
    fail();
  if (!tx.getInput(1).finalScriptSig?.length) fail();
}
