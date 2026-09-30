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
  if (change > 0n && change < changeDustLimit(nestedPaymentAddress(changeAddress)))
    throw new Error("Change is too small. Adjust amount or inputs.");
  tx.addOutput({ amount, script });
  if (change > 0n) tx.addOutputAddress(changeAddress, change, BITCOIN_NETWORK);
  return tx;
}
const varintSize = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);
/** Whether an Xverse payment address is nested SegWit (P2SH-P2WPKH) rather than native P2WPKH. */
export function nestedPaymentAddress(address: string): boolean {
  const decoded = btc.Address(BITCOIN_NETWORK).decode(address);
  if (decoded.type === "sh") return true;
  if (decoded.type === "wpkh") return false;
  throw new Error("Only Xverse P2WPKH and nested SegWit payment inputs are supported.");
}
/**
 * Virtual size of the funding transaction from fundingPsbt once Xverse has signed it.
 * Every input spends the wallet's P2WPKH or nested-SegWit payment output. Its witness is
 * [DER signature, compressed key], counted at the 72-byte DER maximum, so the size is an
 * upper bound and the paid rate is never below the requested one. Nested inputs also
 * carry a 23-byte scriptSig pushing the P2WPKH redeem script.
 */
export function fundingVsize(
  inputCount: number,
  nested: boolean,
  vaultScriptLength: number,
  change: boolean,
): number {
  if (!Number.isSafeInteger(inputCount) || inputCount < 1)
    throw new Error("Select at least one confirmed payment UTXO.");
  const changeScript = nested ? 23 : 22;
  const outputs =
    8 + varintSize(vaultScriptLength) + vaultScriptLength +
    (change ? 8 + 1 + changeScript : 0);
  const base =
    4 + varintSize(inputCount) + inputCount * (41 + (nested ? 23 : 0)) +
    varintSize(change ? 2 : 1) + outputs + 4;
  const witness = 2 + inputCount * (1 + 1 + 72 + 1 + 33);
  return Math.ceil((base * 4 + witness) / 4);
}
/**
 * Bitcoin Core's dust limit, at its default 3 sat/vB dust relay fee, for change back to an
 * Xverse payment address: 294 sats for P2WPKH, 540 for nested SegWit (P2SH).
 */
export function changeDustLimit(nested: boolean): bigint {
  return nested ? 540n : 294n;
}
/** A sat/vB rate as integer millisatoshis per vB: positive, at most 3 decimals and 1,000 sat/vB. */
export function parseFeeRate(value: string): bigint {
  const match = /^(\d{1,4})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new Error("Enter the miner fee rate in sat/vB, for example 2 or 1.5.");
  const rate = BigInt(match[1]) * 1000n + BigInt((match[2] ?? "").padEnd(3, "0"));
  if (rate <= 0n) throw new Error("The miner fee rate must be above 0 sat/vB.");
  if (rate > 1_000_000n) throw new Error("The miner fee rate is above 1,000 sat/vB. Check the rate.");
  return rate;
}
/**
 * MARA's minimum acceptable rate in sat/vB. Its site says the minimum is "the higher of either
 * 1x the current mempool priority fee rate or 1 sats/vByte". In /api/rates, `submit_fee_rate` is
 * the absolute floor and `market_rate` the mempool priority rate. `effective_rate` also carries
 * Slipstream's premium multiplier, so it isn't used: it could refuse a rate MARA accepts.
 */
export function minerMinimumRate(rates: { submit_fee_rate: number; market_rate?: number }): number {
  if (!Number.isFinite(rates.submit_fee_rate) || rates.submit_fee_rate < 0)
    throw new Error("Invalid miner fee floor.");
  const market = rates.market_rate;
  return typeof market === "number" && Number.isFinite(market) && market > rates.submit_fee_rate
    ? market
    : rates.submit_fee_rate;
}
/** Whether a rate (millisatoshis per vB) is below MARA's submission floor (sat/vB), rounding the floor up. */
export function belowMinerFloor(milliSatPerVb: bigint, floorSatPerVb: number): boolean {
  if (!Number.isFinite(floorSatPerVb) || floorSatPerVb < 0) throw new Error("Invalid miner fee floor.");
  // Round to a micro-sat first, so float error (4.03 * 1000 = 4030.0000000000005) can't lift the floor.
  return milliSatPerVb < BigInt(Math.ceil(Math.round(floorSatPerVb * 1e6) / 1e3));
}
/**
 * The miner fee fundingPsbt should use for a sat/vB rate. With change, the fee is
 * rate × vsize rounded up. If the change would be below the dust limit, the
 * transaction has no change output and that remainder is added to the fee, so the
 * effective rate is higher than requested (vsize and fee are both reported).
 */
export function fundingFeeForRate(
  inputValues: bigint[],
  nested: boolean,
  vaultScriptLength: number,
  amount: bigint,
  milliSatPerVb: bigint,
): { fee: bigint; vsize: number; change: boolean } {
  if (amount <= 0n) throw new Error("Amount and fee must be positive.");
  const total = inputValues.reduce((sum, value) => sum + value, 0n);
  const feeAt = (vsize: number) => (BigInt(vsize) * milliSatPerVb + 999n) / 1000n;
  const withChange = fundingVsize(inputValues.length, nested, vaultScriptLength, true);
  const feeWithChange = feeAt(withChange);
  if (total - amount - feeWithChange >= changeDustLimit(nested))
    return { fee: feeWithChange, vsize: withChange, change: true };
  const withoutChange = fundingVsize(inputValues.length, nested, vaultScriptLength, false);
  if (total - amount < feeAt(withoutChange))
    throw new Error("Insufficient funds, including miner fee.");
  return { fee: total - amount, vsize: withoutChange, change: false };
}
/**
 * Upper bound on a Config A QSB scriptSig, from cmd_assemble in public/qsb/qsb_pipeline.py.
 * For each round it pushes the puzzle and nonce keys (33-byte compressed keys), one dummy
 * key per subset index (t = 9 in both rounds), one 20-byte HORS preimage per signed index
 * (8, then 7) and the t witness index numbers. Each index number is at most a 3-byte push,
 * because stack positions are below Bitcoin's 1,000-item limit. The pinning keys come last.
 * Round 1: 2*34 + 9*34 + 8*21 + 9*3 = 569. Round 2: 2*34 + 9*34 + 7*21 + 9*3 = 548. Pin: 68.
 */
export const QSB_CONFIG_A_MAX_SCRIPTSIG = 1185;
/**
 * Virtual size of a signed two-input QSB withdrawal: input 0 is the wallet's helper payment
 * output (P2WPKH or nested SegWit, witness counted at the 72-byte DER maximum), input 1 is
 * the legacy QSB input whose scriptSig is at most QSB_CONFIG_A_MAX_SCRIPTSIG, and the single
 * output pays the destination script. With the default scriptSig bound it's an upper bound.
 */
export function withdrawalVsize(
  nestedHelper: boolean,
  outputScriptLength: number,
  scriptSigLength = QSB_CONFIG_A_MAX_SCRIPTSIG,
): number {
  const base =
    4 + 1 + 41 + (nestedHelper ? 23 : 0) +
    32 + 4 + varintSize(scriptSigLength) + scriptSigLength + 4 +
    1 + 8 + varintSize(outputScriptLength) + outputScriptLength + 4;
  // Segwit marker and flag, the helper's witness, and the QSB input's empty witness.
  const witness = 2 + (1 + 1 + 72 + 1 + 33) + 1;
  return Math.ceil((base * 4 + witness) / 4);
}
/** Withdrawal miner fee for a sat/vB rate: rate × the upper-bound vsize, rounded up. */
export function withdrawalFeeForRate(
  nestedHelper: boolean,
  outputScriptLength: number,
  milliSatPerVb: bigint,
): { fee: bigint; vsize: number } {
  const vsize = withdrawalVsize(nestedHelper, outputScriptLength);
  return { fee: (BigInt(vsize) * milliSatPerVb + 999n) / 1000n, vsize };
}
/** Virtual size of a raw transaction: weight = 3 × size without witnesses + full size. */
export function transactionVsize(rawTxHex: string): number {
  const tx = btc.Transaction.fromRaw(hex.decode(rawTxHex), opts);
  const weight = 3 * tx.toBytes(true, false).length + tx.toBytes(true, true).length;
  return Math.ceil(weight / 4);
}
function assertSighashAll(input: ReturnType<btc.Transaction["getInput"]>) {
  // SIGHASH_ALL is 0x01. NONE|ANYONECANPAY (0x82) and every other type are refused.
  if (input.sighashType !== undefined && input.sighashType !== 1)
    throw new Error("Wallet used a sighash other than SIGHASH_ALL.");
  const signatures = (input.partialSig ?? []).map(([, signature]) => signature);
  if (input.finalScriptWitness?.length === 2)
    signatures.push(input.finalScriptWitness[0]);
  for (const signature of signatures) {
    if (signature.length < 9 || signature[signature.length - 1] !== 1)
      throw new Error("Wallet used a sighash other than SIGHASH_ALL.");
  }
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
    assertSighashAll(a);
  }
  return actual;
}
/** What the manifest says the vault input is; checked against the previous transaction's bytes. */
export type QsbPreviousOutput = { value: bigint | string; scriptHex: string };
export function helperPsbt(
  rawQsbTxHex: string,
  helper: FundingInput,
  qsbPreviousTxHex: string,
  qsbPrevious: QsbPreviousOutput,
) {
  const tx = btc.Transaction.fromRaw(hex.decode(rawQsbTxHex), opts);
  if (tx.inputsLength !== 2 || tx.outputsLength !== 1)
    throw new Error("Expected a two-input QSB withdrawal.");
  // Parsed ids are lowercase; a manifest stored before txids were canonicalised may not be.
  const helperTxid = helper.txid.toLowerCase();
  const input = tx.getInput(0);
  if (
    !input.txid ||
    hex.encode(input.txid) !== helperTxid ||
    input.index !== helper.vout
  )
    throw new Error("Wrong helper input.");
  const prev = btc.Transaction.fromRaw(hex.decode(helper.previousTxHex), opts);
  if (
    prev.id !== helperTxid ||
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
  // The QSB input's scriptSig doesn't commit to its amount, so an understated
  // manifest value would still assemble, with the difference going to the miner
  // fee. Bind the manifest to the previous output's real amount and script.
  const qsbOutput = qsbPrev.getOutput(qsbInput.index);
  if (
    qsbOutput.amount !== BigInt(qsbPrevious.value) ||
    hex.encode(qsbOutput.script!) !== qsbPrevious.scriptHex.toLowerCase()
  )
    throw new Error("QSB previous output amount or script mismatch.");
  if (!qsbInput.finalScriptSig?.length)
    throw new Error("QSB authorization is missing.");
  if (helperTxid === qsbPrev.id && helper.vout === qsbInput.index)
    throw new Error("Helper and QSB input must be different outputs.");
  const script = outputScript(helper.address);
  if (hex.encode(prev.getOutput(helper.vout).script!) !== hex.encode(script))
    throw new Error("Helper address mismatch.");
  tx.updateInput(
    0,
    {
      sighashType: 1,
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
