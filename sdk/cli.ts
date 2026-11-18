import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { apiErrorCodes } from "../server/api-errors";
import { parseBtc } from "../src/lib/model";
import { ApiRequestError, QsbClient, preparedDepositSchema, publicApi } from "./client";
import { ExternalAgentError, externalAgent } from "./agent";
import { Prompter, UsageError, assertOutputs, filePendingDeposits, readPsbtFile, readTextFile,
  writePublicFile, type CliIo } from "./cli-io";

const usage = `Usage: qsb <command> [options] (QSB_NETWORK must be mainnet)

All custody, signing, credentials and durable one-time authorizations belong to an external agent.
No backups, passphrases, seeds, raw keys or session caches are accepted by this CLI.

  config | rates | service-fee
  utxos | vault list
  vault create --name <name> --descriptor <public JSON file>
  deposit prepare <vault> --amount <BTC> --fee-rate <sat/vB> --utxo <txid:vout>... --out <file>
                  [--service-fee <max sats>]
  deposit submit --prepared <file> --signed <PSBT file> --accept-costs
  deposit status <vault> | deposit resubmit <vault>
  withdraw create <vault> [--helper <txid:vout>] --destination <address> --fee-rate <sat/vB> --accept-costs
                  [--solver <id>]
                  --helper is required for a Config A vault. Without it a PQB vault is the only input.
                  Retry with the vault id and --accept-costs only: the agent retains the exact intent.
  withdraw list | withdraw status <job> | withdraw pause <job> | withdraw resume <job>
  withdraw prepare <job> --out <public signing request JSON>
  withdraw assemble <job> --out <signed result JSON>
  withdraw submit --signed <result JSON> [--approve-txid <txid>]

  --api <url>          Or QSB_API_URL
  --base-path <path>   /v1 (default) or /api
  --agent <executable> Or QSB_AGENT; caller-owned JSON-over-pipes adapter, no shell arguments
  --address <address> Or QSB_ADDRESS
  --public-key <hex>  Or QSB_PUBLIC_KEY
  --home <dir>        Public pending deposit records only (default ~/.qsb)
  --help

The agent must independently approve exact transactions and durably enforce one intent and assembly
per vault across every device. --approve-txid bypasses the terminal approval prompt; use it only after
your own approval gate. See sdk/README.md for the agent protocol.
`;
const options = {
  api: { type: "string" }, "base-path": { type: "string" }, agent: { type: "string" },
  address: { type: "string" }, "public-key": { type: "string" }, home: { type: "string" },
  name: { type: "string" }, descriptor: { type: "string" }, amount: { type: "string" },
  "fee-rate": { type: "string" }, utxo: { type: "string", multiple: true }, out: { type: "string" },
  prepared: { type: "string" }, signed: { type: "string" }, "accept-costs": { type: "boolean" },
  "service-fee": { type: "string" }, helper: { type: "string" }, destination: { type: "string" },
  solver: { type: "string" }, "approve-txid": { type: "string" }, help: { type: "boolean", short: "h" },
} as const;
function point(value: string) {
  const match = /^([0-9a-f]{64}):(\d{1,10})$/i.exec(value);
  if (!match || Number(match[2]) > 0xffffffff) throw new UsageError("Expected <txid>:<vout>.");
  return { txid: match[1].toLowerCase(), vout: Number(match[2]) };
}
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const prompts = new Prompter(io);
  let diagnostic = "QSB setup failed. Check the API URL, payment identity and external agent.";
  const print = (value: unknown) => io.stdout.write(JSON.stringify(value, null, 2) + "\n");
  try {
    const { values: v, positionals: words } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    if (v.help || !words.length) { io.stdout.write(usage); return v.help ? 0 : 2; }
    const need = (value: string | undefined, label: string) => {
      if (!value) throw new UsageError(`${label} is required.`); return value;
    };
    const api = need(v.api ?? io.env.QSB_API_URL, "--api");
    const basePath = v["base-path"] ?? "/v1";
    if (basePath !== "/v1" && basePath !== "/api") throw new UsageError("--base-path is /v1 or /api.");
    const [group, action, target] = words;
    diagnostic = group === "vault" ? "Vault operation failed. Check the public descriptor and external recovery availability."
      : group === "deposit" ? "Deposit operation failed. Check public funding status and the prepared PSBT; retain any pending signed bytes."
      : group === "withdraw" ? action === "submit"
        ? "Withdrawal submission was not confirmed. Keep the signed result and check public job status; do not repeat an uncertain submission."
        : action === "create" ? "Search creation failed. Check public job status and the external intent journal before retrying."
        : "Withdrawal operation failed. Check public job status, the external authorization journal and the exact signing request."
      : "Public lookup failed. Check the API endpoint and public service status.";
    const arity = (n: number) => { if (words.length !== n) throw new UsageError("Wrong number of arguments. See --help."); };
    if (["config", "rates", "service-fee"].includes(group)) {
      arity(1); const apiClient = publicApi({ baseUrl: api, basePath, fetch: io.fetch });
      print(await (group === "config" ? apiClient.config() : group === "rates" ? apiClient.rates() : apiClient.serviceFee()));
      return 0;
    }
    const providers = externalAgent(need(v.agent ?? io.env.QSB_AGENT, "--agent"), {
      baseUrl: api, address: need(v.address ?? io.env.QSB_ADDRESS, "--address"),
      publicKey: need(v["public-key"] ?? io.env.QSB_PUBLIC_KEY, "--public-key"), cwd: io.cwd, env: io.env,
    });
    const client = new QsbClient({ baseUrl: api, basePath, fetch: io.fetch, ...providers,
      pendingDeposits: filePendingDeposits(path.resolve(io.cwd, v.home ?? io.env.QSB_HOME ?? path.join(homedir(), ".qsb"))) });
    const cost = () => {
      if (!v["accept-costs"]) throw new UsageError("--accept-costs is required after reviewing miner fees and GPU search costs.");
      return true as const;
    };
    const identifier = () => need(target, "vault/job id");
    const out = () => {
      const file = need(v.out, "--out"); assertOutputs(io, [file], [v.descriptor, v.prepared, v.signed]); return file;
    };
    switch (`${group} ${action ?? ""}`.trim()) {
      case "utxos": arity(1); print(await client.utxos()); return 0;
      case "vault list": arity(2); print(await client.vaults.list()); return 0;
      case "vault create":
        arity(2); print(await client.vaults.create({ name: need(v.name, "--name"),
          descriptor: JSON.parse(await readTextFile(io, need(v.descriptor, "--descriptor"))) })); return 0;
      case "deposit prepare": {
        arity(3); const file = out();
        const prepared = await client.deposits.prepare(identifier(), { amount: parseBtc(need(v.amount, "--amount")),
          feeRate: need(v["fee-rate"], "--fee-rate"), utxos: (v.utxo ?? []).map(point),
          ...(v["service-fee"] ? { serviceFee: { maxSats: v["service-fee"] } } : {}) });
        await writePublicFile(io, file, JSON.stringify(prepared, null, 2) + "\n"); print(prepared); return 0;
      }
      case "deposit submit": {
        arity(2); const accepted = cost();
        const result = await client.deposits.submit(preparedDepositSchema.parse(JSON.parse(await readTextFile(io, need(v.prepared, "--prepared")))),
          await readPsbtFile(io, need(v.signed, "--signed")), { costAccepted: accepted });
        print(result); return result.submission === "submitted" ? 0 : 1;
      }
      case "deposit status": arity(3); print(await client.deposits.status(identifier())); return 0;
      case "deposit resubmit": {
        arity(3); const result = await client.deposits.resubmit(identifier()); print(result); return result.submission === "submitted" ? 0 : 1;
      }
      case "withdraw create":
        arity(3); print(await client.withdrawals.create({ vaultId: identifier(), costAccepted: cost(),
          ...(v.helper ? { helper: point(v.helper) } : {}), ...(v.destination ? { destination: v.destination } : {}),
          ...(v["fee-rate"] ? { feeRate: v["fee-rate"] } : {}), ...(v.solver ? { solverReleaseId: v.solver } : {}) })); return 0;
      case "withdraw list": arity(2); print(await client.withdrawals.list()); return 0;
      case "withdraw status": case "withdraw pause": case "withdraw resume":
        arity(3); print(await client.withdrawals[action as "status" | "pause" | "resume"](identifier())); return 0;
      case "withdraw prepare": case "withdraw assemble": {
        arity(3); const file = out();
        const result = action === "prepare" ? await client.withdrawals.prepare(identifier()) : await client.withdrawals.assemble(identifier());
        await writePublicFile(io, file, JSON.stringify(result, null, 2) + "\n"); print(result); return 0;
      }
      case "withdraw submit": {
        arity(2);
        if (!io.interactive && !v["approve-txid"])
          throw new UsageError("Non-interactive submission requires --approve-txid after reviewing the exact transaction.");
        const signed = JSON.parse(await readTextFile(io, need(v.signed, "--signed")));
        const result = await client.withdrawals.submit(signed, { approve: async review => {
          io.stderr.write(`Mainnet withdrawal ${review.txid}\nDestination: ${review.destination}\nPayout: ${review.outputValue} sats\nFee: ${review.fee} sats (${review.feeRate} sat/vB)\n`);
          if (v["approve-txid"]) { io.stderr.write("Non-interactive approval: your external approval gate must have approved these exact bytes.\n"); return v["approve-txid"]; }
          return prompts.line("Type the exact transaction ID to submit: ");
        } });
        print(result);
        return result.status === "uncertain" ? 1 : 0;
      }
      default: throw new UsageError("Unknown command. See --help.");
    }
  } catch (error) {
    // Only local static diagnostics and codes from the owning API allowlist may be displayed.
    // Never echo arbitrary exception text, agent payloads/stderr, argv values or JSON parse input.
    const usageError = error instanceof UsageError || (error as { code?: string })?.code?.startsWith("ERR_PARSE_ARGS");
    const api = error instanceof ApiRequestError ? error
      : error instanceof Error && error.cause instanceof ApiRequestError ? error.cause : undefined;
    if (error instanceof UsageError) diagnostic = error.diagnostic;
    else if (usageError) diagnostic = "Invalid or unknown command option. See --help.";
    else if (error instanceof ExternalAgentError) {
      const messages: Record<ExternalAgentError["operation"], string> = {
        "credentials.get": "External credentials are unavailable. Refresh or unlock credentials in your external provider.",
        "authorizations.get": "The external authorization journal is unavailable. Restore access to the shared durable store.",
        "authorizations.claim": "The external authorization claim failed. Check journal availability or a conflicting claim; resume the original intent/assembly and never reset claims.",
        "custody.confirmVault": "External recovery confirmation failed. Verify durable recovery for this exact public descriptor.",
        "custody.authorizeWithdrawal": "External withdrawal authorization failed. Review the exact signing request and the manager's one-time authorization state.",
        "wallet.signPsbt": "External wallet signing failed. Check the wallet connection and exact PSBT approval.",
      };
      diagnostic = messages[error.operation];
    } else if (api?.code && Object.hasOwn(apiErrorCodes, api.code))
      diagnostic = `API ${api.code}: ${apiErrorCodes[api.code as keyof typeof apiErrorCodes]}`;
    else if (api?.status === 401) diagnostic = "API authentication failed. Refresh credentials in the external provider.";
    io.stderr.write(diagnostic + "\n");
    return usageError ? 2 : 1;
  } finally { prompts.close(); }
}
