import { spawn } from "node:child_process";
import path from "node:path";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import type { Esplora } from "./chain";

export interface ConsensusVerifier {
  verify(raw: string, chain: Esplora): Promise<void>;
}
export class ConsensusError extends Error {
  constructor() {
    super("Offline Bitcoin Core consensus verification failed.");
  }
}
/** Public bytes only. Native process cannot broadcast and receives no credentials. */
export class CoreConsensus implements ConsensusVerifier {
  constructor(
    private executable = path.resolve(
      process.env.LAMBDA_TASK_ROOT ?? process.cwd(),
      "native/qsb-consensus",
    ),
  ) {}
  async verify(raw: string, chain: Esplora): Promise<void> {
    try {
      if (!/^(?:[a-f0-9]{2})+$/i.test(raw) || raw.length > 150000)
        throw new ConsensusError();
      const tx = btc.Transaction.fromRaw(hex.decode(raw), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      });
      if (tx.inputsLength !== 2 || tx.outputsLength === 0)
        throw new ConsensusError();
      const maxMoney = 2100000000000000n;
      let outputTotal = 0n,
        inputTotal = 0n;
      for (let i = 0; i < tx.outputsLength; i++) {
        const amount = tx.getOutput(i).amount;
        if (amount === undefined || amount < 0n || amount > maxMoney)
          throw new ConsensusError();
        outputTotal += amount;
        if (outputTotal > maxMoney) throw new ConsensusError();
      }
      const rows: string[] = [raw.toLowerCase(), String(tx.inputsLength)];
      const spentOutputs = await Promise.all(
        Array.from({ length: tx.inputsLength }, async (_, i) => {
          const input = tx.getInput(i);
          const id = hex.encode(input.txid!);
          const previous = await chain.raw(id);
          const output = previous.tx.getOutput(input.index!);
          if (
            output.amount === undefined ||
            output.amount < 0n ||
            output.amount > maxMoney ||
            !output.script
          )
            throw new ConsensusError();

          const script = hex.encode(output.script);
          // Reject unknown witness versions; this verifier deliberately implements the
          // currently activated SegWit v0 and Taproot v1 rules, not future upgrades.
          const s = output.script;
          if (
            s.length >= 4 &&
            s.length <= 42 &&
            s[1] === s.length - 2 &&
            s[0] >= 0x51 &&
            s[0] <= 0x60 &&
            !(s[0] === 0x51 && s.length === 34)
          )
            throw new ConsensusError();
          const observation = await chain.unspent(
            { txid: id, vout: input.index!, value: String(output.amount) },
            script,
          );
          const first = previous.tx.getInput(0);
          const coinbase =
            previous.tx.inputsLength === 1 &&
            first.index === 0xffffffff &&
            first.txid !== undefined &&
            first.txid.every((byte) => byte === 0);
          if (
            coinbase &&
            (!Number.isSafeInteger(observation.confirmations) ||
              observation.confirmations < 100)
          )
            throw new ConsensusError();
          return { amount: output.amount, script };
        }),
      );
      for (const output of spentOutputs) {
        inputTotal += output.amount;
        if (inputTotal > maxMoney) throw new ConsensusError();
        rows.push(String(output.amount), output.script);
      }
      if (inputTotal < outputTotal) throw new ConsensusError();
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.executable, [], {
          env: { LANG: "C" },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15000,
          killSignal: "SIGKILL",
        });
        let stdout = "",
          size = 0;
        const fail = () => {
          child.kill("SIGKILL");
          reject(new ConsensusError());
        };
        child.on("error", fail);
        child.stdin.on("error", fail);
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024) fail();
          else stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024) fail();
        });
        child.on("close", (code, signal) =>
          code === 0 &&
          !signal &&
          stdout === "core-27.2-api2-all-inputs-valid\n"
            ? resolve()
            : reject(new ConsensusError()),
        );
        child.stdin.end(rows.join("\n") + "\n");
      });
    } catch {
      throw new ConsensusError();
    }
  }
}
