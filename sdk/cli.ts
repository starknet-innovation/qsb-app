import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { formatBtc, parseBtc } from "../src/lib/model";
import { ApiError, QsbClient, preparedDepositSchema, publicApi, type WithdrawalReview } from "./client";
import {
  Prompter,
  SignatureNeeded,
  UsageError,
  assertOutputs,
  clearSession,
  externalSigner,
  fileAuthorizations,
  filePendingDeposits,
  loadSession,
  readPassphrase,
  readPsbtFile,
  readTextFile,
  saveSession,
  writeNewPrivateFile,
  writePublicFile,
  type CliIo,
} from "./cli-io";
import type { LocalQsb } from "./runtime";
import { loopbackTestSigner } from "./test-signer";

const usage = `qsb: non-custodial QSB client. Keys, recovery state and passphrases stay on this machine.

Usage: npm run qsb -- <command> [options]      (QSB_NETWORK must be mainnet or testnet4)

Account
  login                         BIP-322 sign-in; caches the 1-hour session token (owner-only file)
  logout                        Forget the cached session
  config | rates | utxos        Server configuration, MARA fee rates, confirmed payment outputs
Vaults
  vault create --name <name> --backup <new file>
  vault list
Deposits (one per vault)
  deposit prepare <vault> --backup <file> --amount <BTC> --fee-rate <sat/vB> --utxo <txid:vout>... --out <file>
  deposit submit --prepared <file> --signed <psbt> --accept-costs
  deposit status <vault> | deposit resubmit <vault>
Withdrawals
  withdraw create <vault> --backup <file> --out-backup <new file> --helper <txid:vout>
                  --destination <address> --fee-rate <sat/vB> --accept-costs [--solver <id>]
  withdraw list | status <job> | pause <job> | resume <job>
  withdraw assemble <job> --backup <file> [--out-backup <new file>] --out <file> [--signed-psbt <file>]
  withdraw submit --signed <file> [--approve-txid <txid>]

Options
  --api <url>            API origin (or QSB_API_URL)
  --app-origin <url>     Origin the server's sign-in challenge must name (or QSB_APP_ORIGIN;
                         default: the --api origin). Nothing else is ever signed.
  --address <address>    Payment address (or QSB_ADDRESS)
  --public-key <hex>     Its compressed public key (or QSB_PUBLIC_KEY)
  --signer <kind>        external (default): write PSBTs and challenges, read signatures back.
                         test-key: raw key from QSB_TEST_SIGNER_KEY, loopback API only.
  --passphrase-fd <n>    Read the recovery passphrase from a file descriptor (or QSB_PASSPHRASE,
                         or a terminal prompt). Passphrases are never taken from arguments.
  --home <dir>           Session cache and pending deposits (or QSB_HOME; default ~/.qsb)
  --no-cache             Keep the session token in memory only
  --psbt-out <file>      Where the external signer writes an unsigned PSBT
  --message-out <file>   Where the external signer also writes the sign-in message
`;

const options = {
  api: { type: "string" },
  "app-origin": { type: "string" },
  address: { type: "string" },
  "public-key": { type: "string" },
  signer: { type: "string" },
  "passphrase-fd": { type: "string" },
  home: { type: "string" },
  "no-cache": { type: "boolean" },
  "psbt-out": { type: "string" },
  "message-out": { type: "string" },
  "signed-psbt": { type: "string" },
  name: { type: "string" },
  backup: { type: "string" },
  "out-backup": { type: "string" },
  amount: { type: "string" },
  "fee-rate": { type: "string" },
  utxo: { type: "string", multiple: true },
  out: { type: "string" },
  prepared: { type: "string" },
  signed: { type: "string" },
  "accept-costs": { type: "boolean" },
  helper: { type: "string" },
  destination: { type: "string" },
  solver: { type: "string" },
  "approve-txid": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function outpoint(value: string) {
  const match = /^([0-9a-f]{64}):(\d{1,10})$/i.exec(value);
  if (!match) throw new UsageError(`Expected <txid>:<vout>, got ${value}.`);
  return { txid: match[1].toLowerCase(), vout: Number(match[2]) };
}
const sats = (value: string) => `${formatBtc(value)} BTC (${BigInt(value).toLocaleString("en-US")} sats)`;
function reviewText(review: WithdrawalReview) {
  return [
    `Withdrawal ready to submit on bitcoin ${review.network}`,
    `  Transaction ID: ${review.txid}`,
    `  Destination:    ${review.destination}`,
    `  Payout:         ${sats(review.outputValue)}`,
    `  Miner fee:      ${sats(review.fee)}`,
    `  Fee rate:       ${review.feeRate.toFixed(2)} sat/vB over ${review.vsize} vB (MARA minimum ${review.minerMinimumFeeRate} sat/vB)`,
    "Submitting sends this exact transaction to MARA Slipstream. It can't be changed or recalled.",
    "",
  ].join("\n");
}

/** Run one CLI command. `qsb` is a trusted test seam for the local QSB runtime. */
export async function runCli(argv: string[], io: CliIo, qsb?: LocalQsb): Promise<number> {
  const prompts = new Prompter(io);
  const say = (text: string) => io.stderr.write(`${text}\n`);
  const print = (value: unknown) => io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    const [group, action, target] = positionals;
    if (values.help || !group) {
      io.stdout.write(usage);
      return values.help ? 0 : 2;
    }
    const need = <K extends keyof typeof values>(key: K): NonNullable<(typeof values)[K]> => {
      const value = values[key];
      if (value === undefined) throw new UsageError(`--${String(key)} is required.`);
      return value as NonNullable<(typeof values)[K]>;
    };
    /** The command's words plus its id, if it takes one. */
    const arity = (count: number) => {
      if (positionals.length !== count) throw new UsageError("Wrong number of arguments. See --help.");
    };
    const home = path.resolve(io.cwd, values.home ?? io.env.QSB_HOME ?? path.join(homedir(), ".qsb"));
    if (group === "logout") {
      await clearSession(home);
      say("Cached session removed.");
      return 0;
    }
    const api = values.api ?? io.env.QSB_API_URL;
    if (!api) throw new UsageError("Set the API origin with --api or QSB_API_URL.");
    // Public routes: no wallet needed to look at a deployment first.
    if (group === "config" || group === "rates") {
      arity(1);
      const open = publicApi({ baseUrl: api, fetch: io.fetch });
      print(await (group === "config" ? open.config() : open.rates()));
      return 0;
    }
    const kind = values.signer ?? "external";
    if (kind !== "external" && kind !== "test-key") throw new UsageError("--signer is external or test-key.");
    if (kind === "test-key" && !io.env.QSB_TEST_SIGNER_KEY)
      throw new UsageError("The test-key signer reads a WIF key from QSB_TEST_SIGNER_KEY.");
    const signer =
      kind === "test-key"
        ? loopbackTestSigner(io.env.QSB_TEST_SIGNER_KEY!, api)
        : externalSigner(
            io,
            prompts,
            {
              address: values.address ?? io.env.QSB_ADDRESS ?? "",
              publicKey: values["public-key"] ?? io.env.QSB_PUBLIC_KEY ?? "",
            },
            {
              messageOut: values["message-out"],
              psbtOut: values["psbt-out"],
              signedPsbt: values["signed-psbt"],
            },
          );
    if (!signer.address || !signer.publicKey)
      throw new UsageError("Set --address and --public-key (or QSB_ADDRESS and QSB_PUBLIC_KEY).");
    const cache = !values["no-cache"];
    const token = cache ? await loadSession(home, api, signer.address) : undefined;
    const client = new QsbClient({
      baseUrl: api,
      appOrigin: values["app-origin"] ?? io.env.QSB_APP_ORIGIN,
      signer,
      fetch: io.fetch,
      qsb,
      pendingDeposits: filePendingDeposits(home),
      authorizations: fileAuthorizations(home),
      token,
    });
    const signIn = async () => {
      if (token) {
        try {
          await client.vaults.list();
          return;
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 401)) throw error;
        }
      }
      await client.login();
      if (cache) await saveSession(home, api, signer.address, client.token!);
    };
    const passphrase = (confirm = false) => readPassphrase(io, prompts, values["passphrase-fd"], confirm);
    const backup = () => readTextFile(io, need("backup"));
    const accepted = () => {
      if (!values["accept-costs"])
        throw new UsageError(
          "Add --accept-costs after reviewing the costs: miner fees are paid in Bitcoin, GPU search time has no fixed quote, and customer billing isn't enabled.",
        );
      return true as const;
    };
    const id = (label: string) => {
      if (!target) throw new UsageError(`Give the ${label} id.`);
      return target;
    };

    switch (`${group} ${action ?? ""}`.trim()) {
      case "login":
        arity(1);
        await client.login();
        if (cache) await saveSession(home, api, signer.address, client.token!);
        say(cache ? `Signed in as ${signer.address}; the session is cached in ${home}.` : `Signed in as ${signer.address}.`);
        return 0;
      case "utxos":
        arity(1);
        await signIn();
        print(await client.utxos());
        return 0;
      case "vault create": {
        arity(2);
        const file = need("backup"), name = need("name");
        assertOutputs(io, [file], [], [values["message-out"]]);
        const secret = await passphrase(true);
        await signIn();
        say("Generating QSB keys locally…");
        const { vault } = await client.vaults.create({
          name,
          passphrase: secret,
          saveBackup: (text) => writeNewPrivateFile(io, file, text),
        });
        say(`Encrypted recovery backup saved to ${file}. Keep it and its passphrase: the server holds only public data, and nobody can recover the vault without both.`);
        print({ vault });
        return 0;
      }
      case "vault list":
        arity(2);
        await signIn();
        print(await client.vaults.list());
        return 0;
      case "deposit prepare": {
        arity(3);
        const vaultId = id("vault");
        const out = need("out");
        const psbtFile = values["psbt-out"] ?? `${out.replace(/\.json$/, "")}.psbt`;
        assertOutputs(io, [out, psbtFile], [values.backup], [values["message-out"]]);
        const text = await backup();
        const secret = await passphrase();
        await signIn();
        const prepared = await client.deposits.prepare(vaultId, {
          backup: text,
          passphrase: secret,
          amount: parseBtc(need("amount")),
          feeRate: need("fee-rate"),
          utxos: (values.utxo ?? []).map(outpoint),
        });
        await writePublicFile(io, out, `${JSON.stringify(prepared, null, 2)}\n`);
        await writePublicFile(io, psbtFile, `${prepared.psbt}\n`);
        say(
          [
            `Deposit of ${sats(prepared.amount)} into ${vaultId}`,
            `  Miner fee: ${sats(prepared.fee)}, at most ${prepared.vsize} vB`,
            `  Change:    ${sats(prepared.change)} back to ${prepared.owner}`,
            `Unsigned PSBT: ${psbtFile}. Sign inputs ${prepared.signInputs.join(", ")} in your wallet without broadcasting,`,
            `then run: deposit submit --prepared ${out} --signed <signed psbt> --accept-costs`,
          ].join("\n"),
        );
        print(prepared);
        return 0;
      }
      case "deposit submit": {
        arity(2);
        const prepared = preparedDepositSchema.parse(JSON.parse(await readTextFile(io, need("prepared"))));
        const signed = await readPsbtFile(io, need("signed"));
        const costAccepted = accepted();
        await signIn();
        const result = await client.deposits.submit(prepared, signed, { costAccepted });
        print(result);
        if (result.submission === "submitted") {
          say(`MARA Slipstream has deposit ${result.txid}. Wait for confirmation before withdrawing.`);
          return 0;
        }
        say(
          result.submission === "rejected"
            ? `MARA refused the deposit: ${result.reason ?? "no reason given"}. Nothing was sent to the network.`
            : `MARA's answer to deposit ${result.txid} was lost. Don't deposit again; run deposit resubmit ${prepared.vaultId}.`,
        );
        return 1;
      }
      case "deposit status":
        arity(3);
        await signIn();
        print(await client.deposits.status(id("vault")));
        return 0;
      case "deposit resubmit": {
        arity(3);
        await signIn();
        const result = await client.deposits.resubmit(id("vault"));
        print(result);
        if (result.submission === "submitted") return 0;
        say(
          result.submission === "rejected"
            ? `MARA refused the deposit: ${result.reason ?? "no reason given"}.`
            : "MARA's answer is still unclear. The same deposit can be resent again; don't make another deposit.",
        );
        return 1;
      }
      case "withdraw create": {
        arity(3);
        const vaultId = id("vault");
        // A new intent is bound into a new backup before any paid work; a resume takes none of these.
        if ((values.helper || values.destination || values["fee-rate"]) && !values["out-backup"])
          throw new UsageError("A new withdrawal needs --out-backup <new file>: the backup that binds its payout is saved first.");
        assertOutputs(io, [values["out-backup"]], [values.backup], [values["message-out"]]);
        const text = await backup();
        const costAccepted = accepted();
        const secret = await passphrase();
        await signIn();
        let saved = false;
        const { job } = await client.withdrawals.create({
          vaultId,
          backup: text,
          passphrase: secret,
          ...(values.helper ? { helper: outpoint(values.helper) } : {}),
          ...(values.destination ? { destination: values.destination } : {}),
          ...(values["fee-rate"] ? { feeRate: values["fee-rate"] } : {}),
          ...(values.solver ? { solverReleaseId: values.solver } : {}),
          costAccepted,
          saveBackup: async (encrypted) => {
            await writeNewPrivateFile(io, need("out-backup"), encrypted);
            saved = true;
          },
        });
        say(
          [
            `Withdrawal search ${job.id} is ${job.status}.`,
            `  Destination: ${job.manifest.destination}`,
            `  Payout:      ${sats(job.manifest.outputValue)}`,
            `  Miner fee:   ${sats(job.manifest.fee)}`,
            saved
              ? `The withdrawal backup ${values["out-backup"]} binds this payout; use it to authorize the result.`
              : `Resumed the intent saved in ${values.backup}; no new backup was written.`,
          ].join("\n"),
        );
        print({ job });
        return 0;
      }
      case "withdraw list":
        arity(2);
        await signIn();
        print(await client.withdrawals.list());
        return 0;
      case "withdraw status":
      case "withdraw pause":
      case "withdraw resume": {
        arity(3);
        const jobId = id("job");
        await signIn();
        print(await client.withdrawals[action as "status" | "pause" | "resume"](jobId));
        return 0;
      }
      case "withdraw assemble": {
        arity(3);
        const jobId = id("job");
        const out = need("out");
        assertOutputs(
          io,
          [values["out-backup"], out],
          [values.backup, values["signed-psbt"]],
          [values["psbt-out"], values["message-out"]],
        );
        const text = await backup();
        const secret = await passphrase();
        await signIn();
        let sealed: string | undefined;
        const signed = await client.withdrawals
          .assemble(jobId, {
            backup: text,
            passphrase: secret,
            saveBackup: async (encrypted: string) => {
              if (!values["out-backup"])
                throw new UsageError(
                  "This backup doesn't bind the assembled transaction yet: add --out-backup <new file> to save the signing backup before signing.",
                );
              await writeNewPrivateFile(io, values["out-backup"], encrypted);
              sealed = values["out-backup"];
              say(`Signing backup saved to ${sealed}. It binds this exact transaction; use it from now on.`);
            },
          })
          .catch((error) => {
            if (error instanceof SignatureNeeded && sealed)
              throw new SignatureNeeded(`${error.message} Pass --backup ${sealed} instead of --out-backup.`);
            throw error;
          });
        await writePublicFile(io, out, `${JSON.stringify(signed, null, 2)}\n`);
        say(`Signed withdrawal ${signed.txid} saved to ${out}. Nothing was broadcast. Review and submit it with: withdraw submit --signed ${out}`);
        print({ jobId: signed.jobId, txid: signed.txid, signed: out });
        return 0;
      }
      case "withdraw submit": {
        arity(2);
        const signed = JSON.parse(await readTextFile(io, need("signed")));
        await signIn();
        const result = await client.withdrawals.submit(signed, {
          approve: async (review) => {
            say(reviewText(review));
            if (values["approve-txid"] !== undefined) return values["approve-txid"];
            if (!io.interactive)
              throw new UsageError("Review the transaction above, then re-run with --approve-txid <its transaction ID>.");
            return (await prompts.line("Type the transaction ID to approve and submit it: ")).trim();
          },
        });
        say(`${result.status}: ${result.txid}. Keep the signed file and check withdraw status; do not submit again.`);
        print(result);
        return result.status === "uncertain" ? 1 : 0;
      }
      default:
        throw new UsageError(`Unknown command "${positionals.join(" ")}". See --help.`);
    }
  } catch (error) {
    if (error instanceof SignatureNeeded) {
      say(error.message);
      return 3;
    }
    say(`qsb: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof UsageError || (error as { code?: string } | null)?.code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  } finally {
    prompts.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2), {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    interactive: Boolean(process.stdin.isTTY),
    // npm runs scripts from the package root; paths are relative to where `npm run qsb` was typed.
    cwd: process.env.INIT_CWD ?? process.cwd(),
  }).then((code) => {
    process.exitCode = code;
  });
}
