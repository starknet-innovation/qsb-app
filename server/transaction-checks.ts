import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import type { PublicVault, Job } from "../src/lib/model";
import { outputScript } from "../src/lib/transactions";
import { ChainError, type Esplora } from "./chain";

const options = { allowUnknownInputs: true, allowUnknownOutputs: true };
function parse(raw: string) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(raw) || raw.length > 150000)
    throw new ChainError("Invalid transaction encoding or size.");
  const tx = btc.Transaction.fromRaw(hex.decode(raw), options);
  if (!tx.inputsLength || !tx.outputsLength)
    throw new ChainError("Empty transaction.");
  const seen = new Set<string>();
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i),
      key = `${hex.encode(input.txid!)}:${input.index}`;
    if (seen.has(key)) throw new ChainError("Duplicate transaction input.");
    seen.add(key);
  }
  return tx;
}
function assertOutput(
  tx: btc.Transaction,
  index: number,
  value: bigint,
  script: string,
) {
  const out = tx.getOutput(index);
  if (
    out.amount !== value ||
    !out.script ||
    hex.encode(out.script) !== script.toLowerCase()
  )
    throw new ChainError(
      "Transaction output does not match the approved intent.",
    );
}
/**
 * A deposit pays the vault script at output 0. Optional change follows.
 * The helper is a separate UTXO chosen at withdrawal, not an output here.
 */
export function matchVaultFunding(
  tx: btc.Transaction,
  scriptHex: string,
  amount: bigint,
): { vout: 0; value: string } {
  if (amount <= 0n || tx.outputsLength < 1)
    throw new ChainError("Invalid funding transaction.");
  const output = tx.getOutput(0);
  const script = output.script ? hex.encode(output.script) : "";
  if (script !== scriptHex.toLowerCase())
    throw new ChainError("Funding transaction does not pay this vault.");
  if (output.amount !== amount)
    throw new ChainError("Funding amount does not match.");
  return { vout: 0, value: amount.toString() };
}
export async function checkFunding(
  raw: string,
  vault: PublicVault,
  amount: bigint,
  fee: bigint,
  chain: Esplora,
) {
  const tx = parse(raw);
  if (tx.inputsLength > 8 || tx.outputsLength > 2 || amount <= 0n || fee <= 0n)
    throw new ChainError("Invalid funding transaction.");
  assertOutput(tx, 0, amount, vault.scriptHex);
  const paymentScript = hex.encode(outputScript(vault.paymentAddress));
  let total = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (!input.finalScriptWitness?.length)
      throw new ChainError("Wallet signature missing.");
    const id = hex.encode(input.txid!),
      index = input.index!;
    const previous = await chain.raw(id),
      out = previous.tx.getOutput(index);
    if (out.amount === undefined)
      throw new ChainError("Previous output value missing.");
    await chain.unspent(
      { txid: id, vout: index, value: out.amount.toString() },
      paymentScript,
    );
    total += out.amount;
  }
  const change = total - amount - fee;
  if (
    change < 0n ||
    (change === 0n ? tx.outputsLength !== 1 : tx.outputsLength !== 2)
  )
    throw new ChainError("Funding fee or change mismatch.");
  if (change > 0n) assertOutput(tx, 1, change, paymentScript);
  return { txid: tx.id, vout: 0, value: amount.toString() };
}
export async function checkWithdrawal(
  raw: string,
  vault: PublicVault,
  job: Job,
  chain: Esplora,
) {
  if (!job.solution || job.status !== "awaiting_authorization")
    throw new ChainError("Withdrawal is not ready for authorization.");
  const tx = parse(raw),
    m = job.manifest,
    hit = job.solution;
  if (
    tx.version !== 1 ||
    tx.lockTime !== hit.locktime ||
    tx.inputsLength !== 2 ||
    tx.outputsLength !== 1
  )
    throw new ChainError("Withdrawal layout or locktime changed.");
  for (const [index, point, sequence] of [
    [0, m.helper, 0xfffffffe],
    [1, m.funding, hit.sequence],
  ] as const) {
    const input = tx.getInput(index);
    if (
      hex.encode(input.txid!) !== point.txid ||
      input.index !== point.vout ||
      input.sequence !== sequence
    )
      throw new ChainError("Withdrawal input changed.");
  }
  if (
    !tx.getInput(1).finalScriptSig?.length ||
    !tx.getInput(0).finalScriptWitness?.length
  )
    throw new ChainError(
      "Withdrawal authorization or wallet signature missing.",
    );
  assertOutput(tx, 0, BigInt(m.outputValue), m.outputScript);
  if (
    hex.encode(outputScript(m.destination)) !== m.outputScript ||
    BigInt(m.outputValue) + BigInt(m.fee) !==
      BigInt(m.funding.value) + BigInt(m.helper.value)
  )
    throw new ChainError("Withdrawal destination or fee mismatch.");
  await chain.unspent(m.funding, vault.scriptHex);
  await chain.unspent(m.helper, hex.encode(outputScript(vault.paymentAddress)));
  return { txid: tx.id };
}
