import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const usage = `Usage (QSB_NETWORK=mainnet, AWS credentials for the fee key's account and region):
  npm run service-fee -- address
      The fee address, from alias/qsb/service-fee's public key.
  npm run service-fee -- sweep --to <address> --fee-rate <sat/vB> [--sign]
      Plan moving every confirmed output at the fee address to <address>, less the miner fee.
      --sign signs it with the KMS key (a signer role's kms:Sign) and prints the raw transaction. Nothing is broadcast:
      review it, then broadcast it yourself.`;

export async function serviceFeeCli(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { to: { type: "string" }, "fee-rate": { type: "string" }, sign: { type: "boolean" } },
  });
  // Imported here so the network is read only once the command line parses.
  const { kmsFeeKey, buildSweep, signSweep, sweepReport } = await import("../server/service-fee-sweep");
  const { BITCOIN_NETWORK } = await import("../src/lib/network");
  const { parseFeeRate } = await import("../src/lib/transactions");
  const { chain } = await import("../server/chain");
  const btc = await import("@scure/btc-signer");
  const command = positionals.join(" ");
  if (command !== "address" && (command !== "sweep" || !values.to || !values["fee-rate"])) throw new Error(usage);
  // Checked before any KMS or chain call.
  const rate = command === "sweep" ? parseFeeRate(values["fee-rate"]!) : 0n;
  if (command === "sweep") btc.Address(BITCOIN_NETWORK).decode(values.to!);
  const key = kmsFeeKey();
  const publicKey = await key.publicKey();
  const address = btc.p2wpkh(publicKey, BITCOIN_NETWORK).address!;
  const print = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (command === "address") return print({ address });
  const to = values.to!;
  const utxos = (await chain.paymentUtxos(address)).map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value) }));
  const plan = buildSweep(utxos, publicKey, to, rate);
  const summary = { from: address, to, inputs: utxos.length, total: plan.total.toString(), fee: plan.fee.toString(), amount: plan.amount.toString(), vsize: plan.vsize };
  if (!values.sign) return print({ ...summary, signed: false, next: "Review, then run again with --sign." });
  const signed = await signSweep(plan.tx, publicKey, key);
  print({ ...sweepReport(signed, plan, to), next: "Check the transaction, then broadcast rawTxHex yourself." });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  serviceFeeCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
