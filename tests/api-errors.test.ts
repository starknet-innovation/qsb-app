import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { z } from "zod";
import { createApp } from "../server/app";
import {
  API_ERROR_CODES,
  attachedApiErrorCode,
  withApiErrorCode,
  type ApiErrorCode,
} from "../server/api-errors";
import { Conflict, MemoryStore } from "../server/store";
import { ChainError, Esplora } from "../server/chain";
import { ConsensusError } from "../server/consensus";
import {
  MinerAuthenticationError,
  Slipstream,
  type MinerCredential,
} from "../server/providers";
import {
  buildStoredSpendRecord,
  type StoredSpendRecord,
} from "../server/job-spend-record";
import { BITCOIN_NETWORK, NETWORK_CONFIG } from "../src/lib/network";
import { outputScript } from "../src/lib/transactions";
import type { Job, PublicVault, Withdrawal } from "../src/lib/model";

// Hermetic: the chain is a real Esplora over an in-memory fetch, the miner and
// consensus are fakes, and a seeded session stands in for sign-in.
const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
const owner = btc
  .Address(BITCOIN_NETWORK)
  .encode({ type: "wpkh", hash: new Uint8Array(20).fill(1) });
const pk = `OWNER#${owner}`;
const token = "A".repeat(43);
const vaultId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const scriptHex = "51".repeat(100);
const manifest: Withdrawal = {
  vaultId,
  funding: { txid: "33".repeat(32), vout: 0, value: "100000" },
  helper: { txid: "44".repeat(32), vout: 1, value: "10000" },
  destination: owner,
  outputScript: hex.encode(outputScript(owner)),
  outputValue: "90000",
  fee: "20000",
  idempotencyKey: jobId,
  costAccepted: true,
};
const solution = {
  sequence: 0x80000000,
  locktime: 500000000,
  round1: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  round2: [9, 10, 11, 12, 13, 14, 15, 16, 17],
};
function vault(overrides: Partial<PublicVault> = {}): PublicVault {
  return {
    id: vaultId,
    name: "cold",
    createdAt: "2026-09-24T00:00:00.000Z",
    network: "mainnet",
    config: "A",
    scriptHex,
    scriptHash: createHash("sha256")
      .update(Buffer.from(scriptHex, "hex"))
      .digest("hex"),
    paymentAddress: owner,
    publicStateJson: JSON.stringify({ config: "A", full_script_hex: scriptHex }),
    status: "unfunded",
    ...overrides,
  };
}
function job(overrides: Partial<Job> & Record<string, unknown> = {}): Job {
  return {
    id: jobId,
    owner,
    vaultId,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    status: "awaiting_authorization",
    stage: "verification",
    manifest,
    manifestHash: "ab".repeat(32),
    attempt: 0,
    computeSeconds: 0,
    revision: 0,
    ...overrides,
  } as Job;
}
/** The withdrawal the stored job approves, with placeholder witness bytes. */
function signedWithdrawal(record: StoredSpendRecord): string {
  const tx = new btc.Transaction({ ...opts, version: 1, lockTime: record.locktime });
  tx.addInput({ txid: record.helper.txid, index: record.helper.vout, sequence: 0xfffffffe });
  tx.addInput({ txid: record.funding.txid, index: record.funding.vout, sequence: record.sequence });
  tx.addOutput({ script: hex.decode(record.outputScript), amount: BigInt(record.outputValue) });
  tx.updateInput(0, { finalScriptWitness: [Uint8Array.of(0x30, 0x01), Uint8Array.of(0x02)] }, true);
  tx.updateInput(1, { finalScriptSig: Uint8Array.of(0x01) }, true);
  return hex.encode(tx.toBytes(true, true));
}
const tx = (raw: string) => btc.Transaction.fromRaw(hex.decode(raw), opts);
/** An unsigned deposit paying `value` to the vault script at output 0. */
function deposit(value = 50_000n) {
  const tx = new btc.Transaction({ ...opts, version: 2 });
  tx.addInput({ txid: new Uint8Array(32).fill(9), index: 0 });
  tx.addOutput({ amount: value, script: hex.decode(scriptHex) });
  return hex.encode(tx.toBytes(true, false));
}

async function setup() {
  const store = new MemoryStore();
  await store.put({
    pk: `SESSION#${createHash("sha256").update(token).digest("hex")}`,
    sk: "AUTH",
    version: 0,
    owner,
    network: "mainnet",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  // Unrouted chain paths answer 500, like a failing provider.
  const routes = new Map<string, () => Response>();
  const chain = new Esplora("https://chain.test", async (input) => {
    const route = routes.get(new URL(String(input)).pathname);
    return route ? route() : new Response("", { status: 500 });
  });
  const miner = {
    rates: vi.fn(async (): Promise<unknown> => ({})),
    status: vi.fn(async (): Promise<unknown> => {
      throw new Error("unknown");
    }),
    credential: vi.fn(
      (): Promise<MinerCredential> =>
        new Slipstream("https://slipstream.mara.com", async () => undefined).credential(),
    ),
    submit: vi.fn(async () => ({ status: "success" })),
    submitFunding: vi.fn(async () => ({ status: "success" })),
    seen: vi.fn(async () => false),
  };
  const consensus = { verify: vi.fn(async () => {}) };
  const deps = {
    chain,
    miner: miner as unknown as Slipstream,
    consensus,
    enabled: true,
    exactSubmit: true,
    apiKeys: false,
  };
  const call = (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    // `raw` sends a body as is; `stream` sends it without a length, so bodyLimit counts it.
    options: { auth?: string | null; app?: Partial<typeof deps>; raw?: string; stream?: string } = {},
  ) => {
    const auth = options.auth === undefined ? token : options.auth;
    return createApp(store, { ...deps, ...options.app }).request(
      new Request("http://localhost/api" + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: "Bearer " + auth } : {}),
        },
        body:
          options.stream !== undefined
            ? new Blob([options.stream]).stream()
            : (options.raw ?? (body === undefined ? undefined : JSON.stringify(body))),
        ...(options.stream !== undefined ? { duplex: "half" } : {}),
      }),
    );
  };
  const putVault = (overrides: Partial<PublicVault> = {}, extra = {}) =>
    store.put({ pk, sk: `VAULT#${vaultId}`, version: 0, vault: vault(overrides), ...extra });
  const putJob = (overrides: Partial<Job> & Record<string, unknown> = {}, extra = {}) =>
    store.put({ pk, sk: `JOB#${jobId}`, version: 0, job: job(overrides), ...extra });
  return { store, routes, chain, miner, consensus, call, putVault, putJob };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const genesis = (f: Fixture, hash = NETWORK_CONFIG.genesisHash) =>
  f.routes.set("/block-height/0", () => new Response(hash));
const confirmedVault = { status: "confirmed" as const, funding: manifest.funding };
const readyToSubmit = async (f: Fixture, overrides: Partial<Job> = {}) => {
  const stored = job({ solution, ...overrides });
  await f.store.put({ pk, sk: `JOB#${jobId}`, version: 0, job: stored });
  await f.putVault(confirmedVault);
  vi.spyOn(f.chain, "unspent").mockResolvedValue({ previousTxHex: "00", confirmations: 1 });
  return { rawTxHex: signedWithdrawal(buildStoredSpendRecord(stored)) };
};
const other = "33333333-3333-4333-8333-333333333333";
const keysOn = { app: { apiKeys: true } };
/** Seed an API key's lookup row directly and return the key. */
const seedKey = async (f: Fixture, fields: Record<string, unknown> = {}) => {
  const key = `qsb_mainnet_${"K".repeat(43)}`;
  await f.store.put({
    pk: `APIKEY#${createHash("sha256").update(key).digest("hex")}`,
    sk: "AUTH",
    version: 0,
    owner,
    id: other,
    scopes: ["read"],
    network: "mainnet",
    createdAt: "2026-09-24T00:00:00.000Z",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    revoked: false,
    ...fields,
  });
  return { ...keysOn, auth: key };
};
/** A confirmed-looking previous transaction with one 70000 sat output to the owner, served by the chain. */
const previousTx = (f: Fixture) => {
  const previous = new btc.Transaction(opts);
  previous.addInput({ txid: new Uint8Array(32).fill(5), index: 0 });
  previous.addOutputAddress(owner, 70_000n, BITCOIN_NETWORK);
  genesis(f);
  f.routes.set(`/tx/${previous.id}/hex`, () => new Response(hex.encode(previous.toBytes(true, true))));
  return previous.id;
};
/** Serve the previous transaction as confirmed, and its output 0 as spent or not. */
const confirmedPrevious = (f: Fixture, spent: boolean) => {
  const id = previousTx(f);
  f.routes.set(`/tx/${id}/status`, () => Response.json({ confirmed: true, block_height: 10, block_hash: "ee".repeat(32) }));
  f.routes.set("/block-height/10", () => new Response("ee".repeat(32)));
  f.routes.set("/blocks/tip/height", () => new Response("12"));
  f.routes.set(`/tx/${id}/outspend/0`, () => Response.json({ spent }));
  return id;
};
/** A vault holding a submitted deposit whose stored bytes the server can resend. */
const resendable = async (f: Fixture) => {
  const raw = deposit();
  await f.putVault({ status: "submitted", funding: { txid: tx(raw).id, vout: 0, value: "50000" } }, { fundingRawTxHex: raw });
};
/** A real Slipstream whose HTTP answers come from `answer`; the credential needs no secret. */
const slipstreamWith = (answer: () => Response) => {
  vi.stubGlobal("fetch", vi.fn(async () => answer()));
  return new Slipstream("https://slipstream.mara.com", async () => undefined);
};

// Each case drives one error path. Together they cover every listed code.
const cases: [ApiErrorCode, number, (f: Fixture) => Response | Promise<Response>][] = [
  ["invalid_request", 400, (f) => f.call("POST", "/auth/challenge", {})],
  ["request_too_large", 413, (f) => f.call("POST", "/auth/challenge", { address: "x".repeat(200_000) })],
  ["invalid_request", 400, (f) => f.call("POST", "/auth/challenge", undefined, { raw: "{" })],
  ["request_too_large", 413, (f) => f.call("POST", "/auth/challenge", undefined, { stream: JSON.stringify({ address: "x".repeat(200_000) }) })],
  ["internal_error", 500, (f) => {
    vi.spyOn(f.chain, "paymentUtxos").mockRejectedValue(new Error("unexpected"));
    return f.call("GET", "/payment-utxos");
  }],
  ["network_mismatch", 400, (f) => f.call("POST", "/auth/challenge", { address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx" })],
  ["challenge_expired", 401, (f) => f.call("POST", "/auth/verify", { id: other, signature: "aa" })],
  ["signature_invalid", 401, async (f) => {
    const { id } = await (await f.call("POST", "/auth/challenge", { address: owner })).json();
    return f.call("POST", "/auth/verify", { id, signature: "aa" });
  }],
  ["auth_required", 401, (f) => f.call("GET", "/vaults", undefined, { auth: null })],
  ["session_expired", 401, (f) => f.call("GET", "/vaults", undefined, { auth: "B".repeat(43) })],
  ["api_key_invalid", 401, (f) => f.call("GET", "/vaults", undefined, { ...keysOn, auth: `qsb_mainnet_${"U".repeat(43)}` })],
  ["api_key_revoked", 401, async (f) => f.call("GET", "/vaults", undefined, await seedKey(f, { revoked: true }))],
  ["api_key_not_allowed", 403, async (f) => f.call("GET", "/api-keys", undefined, await seedKey(f))],
  ["api_key_scope_denied", 403, async (f) => f.call("POST", "/vaults", {}, await seedKey(f))],
  ["api_key_limit_reached", 409, async (f) => {
    for (let i = 0; i < 10; i++)
      await f.store.put({ pk, sk: `APIKEY#${i}`, version: 0, revoked: false, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    return f.call("POST", "/api-keys", { name: "ci", scopes: ["read"] }, keysOn);
  }],
  ["api_key_not_found", 404, (f) => f.call("POST", `/api-keys/${other}/revoke`, {}, keysOn)],
  ["api_keys_disabled", 503, (f) => f.call("POST", "/api-keys", { name: "ci", scopes: ["read"] })],
  ["miner_rate_unavailable", 503, (f) => {
    f.miner.rates.mockRejectedValue(new Error("down"));
    return f.call("GET", "/rates");
  }],
  ["vault_invalid", 400, (f) => f.call("POST", "/vaults", vault({ paymentAddress: "bc1qunrelatedowner0000" }))],
  ["operations_disabled", 503, (f) => f.call("POST", `/vaults/${vaultId}/fund`, {}, { app: { enabled: false } })],
  ["submit_disabled", 503, (f) => f.call("POST", `/vaults/${vaultId}/fund/submit`, {}, { app: { exactSubmit: false } })],
  ["vault_not_found", 404, (f) => f.call("GET", `/vaults/${other}/funding`)],
  ["network_mismatch", 409, async (f) => {
    await f.putVault({ network: "testnet4" });
    return f.call("GET", `/vaults/${vaultId}/funding`);
  }],
  ["vault_not_funded", 409, async (f) => {
    await f.putVault();
    return f.call("GET", `/vaults/${vaultId}/funding`);
  }],
  ["funding_intent_exists", 409, async (f) => {
    await f.putVault({ status: "submitted" });
    return f.call("POST", `/vaults/${vaultId}/fund`, { txid: "ab".repeat(32), amount: "50000", costAccepted: true });
  }],
  ["funding_intent_exists", 409, async (f) => {
    await f.putVault({ status: "submitted", funding: { txid: "ab".repeat(32), vout: 0, value: "50000" } }, { fundingRawTxHex: "00" });
    return f.call("POST", `/vaults/${vaultId}/fund/submit`, { rawTxHex: deposit(), amount: "50000", costAccepted: true });
  }],
  ["funding_transaction_invalid", 409, (f) => f.call("POST", `/vaults/${vaultId}/fund/submit`, { rawTxHex: "00", amount: "50000", costAccepted: true })],
  ["funding_transaction_invalid", 409, async (f) => {
    await f.putVault();
    return f.call("POST", `/vaults/${vaultId}/fund/submit`, { rawTxHex: deposit(49_999n), amount: "50000", costAccepted: true });
  }],
  ["vault_not_found", 409, (f) => f.call("POST", `/vaults/${vaultId}/fund/submit`, { rawTxHex: deposit(), amount: "50000", costAccepted: true })],
  ["signed_deposit_not_found", 404, async (f) => {
    await f.putVault();
    return f.call("GET", `/vaults/${vaultId}/fund/signed`);
  }],
  ["chain_transaction_not_found", 409, async (f) => {
    await f.putVault();
    genesis(f);
    f.routes.set(`/tx/${"ab".repeat(32)}/hex`, () => new Response("", { status: 404 }));
    return f.call("POST", `/vaults/${vaultId}/fund`, { txid: "ab".repeat(32), amount: "50000", costAccepted: true });
  }],
  ["chain_unavailable", 409, (f) => f.call("GET", "/payment-utxos")],
  ["chain_error", 409, (f) => {
    genesis(f, "00".repeat(32));
    return f.call("GET", "/payment-utxos");
  }],
  ["input_mismatch", 409, (f) => f.call("POST", "/payment-input", { txid: previousTx(f), vout: 0, value: "69999" })],
  ["input_unconfirmed", 409, (f) => {
    const id = previousTx(f);
    f.routes.set(`/tx/${id}/status`, () => Response.json({ confirmed: false }));
    f.routes.set(`/tx/${id}/outspend/0`, () => Response.json({ spent: false }));
    return f.call("POST", "/payment-input", { txid: id, vout: 0, value: "70000" });
  }],
  ["input_spent", 409, (f) => f.call("POST", "/payment-input", { txid: confirmedPrevious(f, true), vout: 0, value: "70000" })],
  ["vault_not_confirmed", 409, async (f) => {
    await f.putVault({ status: "submitted", funding: manifest.funding });
    return f.call("POST", "/jobs", manifest);
  }],
  ["withdrawal_invalid", 409, async (f) => {
    await f.putVault({ status: "confirmed", funding: { ...manifest.funding, vout: 1 } });
    return f.call("POST", "/jobs", manifest);
  }],
  ["solver_not_served", 503, async (f) => {
    vi.stubEnv("SOLVER_RELEASE_ID", "");
    await f.putVault(confirmedVault);
    return f.call("POST", "/jobs", manifest);
  }],
  ["idempotency_conflict", 409, async (f) => {
    await f.putJob();
    return f.call("POST", "/jobs", manifest);
  }],
  ["job_not_found", 404, (f) => f.call("GET", `/jobs/${jobId}/status`)],
  ["job_not_found", 409, (f) => f.call("POST", `/jobs/${jobId}/submit`, { rawTxHex: "00" })],
  ["job_unsupported", 409, async (f) => {
    await f.putJob({ status: "queued", execution: { kind: "qsb-supervised-service-v1" } });
    return f.call("POST", `/jobs/${jobId}/pause`);
  }],
  ["job_state_invalid", 409, async (f) => {
    await f.putJob({ status: "confirmed" });
    return f.call("POST", `/jobs/${jobId}/pause`);
  }],
  ["job_state_invalid", 409, async (f) =>
    f.call("POST", `/jobs/${jobId}/submit`, await readyToSubmit(f, { status: "searching" })),
  ],
  ["state_conflict", 409, async (f) => {
    await f.putJob({ status: "queued" });
    vi.spyOn(f.store, "put").mockRejectedValue(new Conflict());
    return f.call("POST", `/jobs/${jobId}/pause`);
  }],
  ["solved_result_unavailable", 404, async (f) => {
    await f.putJob({ status: "searching" });
    return f.call("GET", `/jobs/${jobId}/solved-result`);
  }],
  ["reconcile_required", 409, async (f) => {
    await f.putJob({ status: "paused", error: "Submission outcome unknown. Reconcile compute provider before resuming." });
    return f.call("POST", `/jobs/${jobId}/resume`);
  }],
  ["operator_review_required", 409, async (f) => {
    await f.putJob({ status: "paused", error: "Search range exhausted." });
    return f.call("POST", `/jobs/${jobId}/resume`);
  }],
  ["coverage_stopped", 409, async (f) => {
    const account = {
      solverPin: "qsb-config-a-ranked-v2-2791ed0",
      sessionId: `${owner}/${jobId}`,
      pinning: [],
      subsets: {},
      stopped: true,
      stopReason: "deterministic-failure",
    };
    await f.putJob({ status: "paused" }, {
      validation: { coverageLedger: { holdSolverBinarySha256: null, measuresHoldSolverBinary: false, accounts: [account] } },
    });
    return f.call("POST", `/jobs/${jobId}/resume`);
  }],
  ["intent_not_found", 404, (f) => f.call("GET", `/transactions/${"cd".repeat(32)}/status`)],
  ["intent_conflict", 409, async (f) => {
    await f.putJob({ txid: "cd".repeat(32) });
    await f.store.put({ pk, sk: `TX#${"cd".repeat(32)}`, version: 0, kind: "exact-withdrawal", jobId: other, txid: "cd".repeat(32) });
    return f.call("GET", `/jobs/${jobId}/status`);
  }],
  ["intent_conflict", 409, async (f) =>
    f.call("POST", `/jobs/${jobId}/submit`, await readyToSubmit(f, { txid: "cd".repeat(32) })),
  ],
  ["inclusion_check_failed", 409, async (f) => {
    await f.store.put({ pk, sk: `TX#${"cd".repeat(32)}`, version: 0, txid: "cd".repeat(32), status: "submitted" });
    f.miner.status.mockResolvedValue({ transaction: { txid: "cd".repeat(32), status: { confirmed: "yes" } } });
    return f.call("GET", `/transactions/${"cd".repeat(32)}/status`);
  }],
  ["exact_spend_mismatch", 409, async (f) => {
    await f.putJob({ solution });
    return f.call("POST", `/jobs/${jobId}/submit`, { rawTxHex: "00" });
  }],
  ["job_state_invalid", 409, async (f) => {
    await f.putJob({ status: "searching", stage: "pinning" });
    return f.call("POST", `/jobs/${jobId}/submit`, { rawTxHex: "00" });
  }],
  ["consensus_rejected", 409, async (f) => {
    const body = await readyToSubmit(f);
    f.consensus.verify.mockRejectedValue(new ConsensusError());
    return f.call("POST", `/jobs/${jobId}/submit`, body);
  }],
  ["miner_unavailable", 503, async (f) => {
    const body = await readyToSubmit(f);
    f.miner.credential.mockRejectedValue(new MinerAuthenticationError("Miner API credential is unavailable. Contact the service operator."));
    return f.call("POST", `/jobs/${jobId}/submit`, body);
  }],
];

const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const text = (node: ts.Node | undefined) =>
  node === undefined ? "-" : ts.isStringLiteral(node) ? node.text : node.getText().replace(/\s+/g, " ");
/** The route (`POST /api/jobs`) or function a node sits in. */
function where(node: ts.Node): string {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression) && at.expression.expression.getText() === "app") {
      const [path] = at.arguments;
      const method = at.expression.name.text;
      return path && ts.isStringLiteral(path) ? `${method.toUpperCase()} ${path.text}` : method;
    }
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) return at.name.getText();
    if (
      ts.isVariableDeclaration(at) &&
      ts.isIdentifier(at.name) &&
      at.initializer &&
      (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))
    )
      return at.name.text;
    if (ts.isCallExpression(at) && ts.isIdentifier(at.expression) && at.expression.text !== "apiError") return at.expression.text;
  }
  return "module";
}
/**
 * Every error site on the default routes, as "file | where | status | code | message":
 * each apiError call in app.ts, each thrown ChainError (and subclass), and each code
 * attached with withApiErrorCode in server/.
 */
function errorSites(): string[] {
  const sites: string[] = [];
  const chainErrors: Record<string, string> = { ChainError: "chain_error", ChainNotFound: "chain_transaction_not_found", WithdrawalConflict: "chain_error" };
  const files = readdirSync(new URL("../server/", import.meta.url)).filter((name) => name.endsWith(".ts")).sort();
  for (const name of files) {
    const file = `server/${name}`;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const [, status, code, message] = node.arguments;
        if (node.expression.text === "apiError")
          sites.push([name, where(node), text(status), text(code), text(message)].join(" | "));
        if (node.expression.text === "withApiErrorCode")
          sites.push([name, where(node), "attached", text(node.arguments[0]), "-"].join(" | "));
      }
      if (ts.isNewExpression(node) && node.expression.getText() in chainErrors) {
        const [message, code] = node.arguments ?? [];
        const className = node.expression.getText();
        sites.push([name, where(node), className, code ? text(code) : chainErrors[className], text(message)].join(" | "));
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
  }
  return sites;
}

// Provider failures that aren't an HTTP answer keep the status and body they had before
// the codes; only `code` says what failed.
const retry = "Unable to complete the request. Please retry.";
const unchanged: [ApiErrorCode, number, string, (f: Fixture) => Response | Promise<Response>][] = [
  ["chain_unavailable", 500, retry, (f) => {
    f.routes.set("/block-height/0", () => {
      throw new TypeError("fetch failed");
    });
    return f.call("GET", "/payment-utxos");
  }],
  ["chain_unavailable", 500, retry, (f) => {
    const broken = new ReadableStream({ start: (c) => c.error(new TypeError("terminated")) });
    f.routes.set("/block-height/0", () => new Response(broken));
    return f.call("GET", "/payment-utxos");
  }],
  ["chain_error", 400, "Invalid request", async (f) => {
    await f.putVault({ status: "submitted", funding: { txid: "ab".repeat(32), vout: 0, value: "50000" } });
    genesis(f);
    f.routes.set(`/tx/${"ab".repeat(32)}/status`, () => new Response("{}"));
    return f.call("GET", `/vaults/${vaultId}/funding`);
  }],
  ["chain_error", 500, retry, (f) => {
    genesis(f);
    f.routes.set(`/address/${owner}/utxo`, () => new Response("not json"));
    return f.call("GET", "/payment-utxos");
  }],
  ["chain_error", 500, retry, async (f) => {
    await f.putVault();
    genesis(f);
    f.routes.set(`/tx/${"ab".repeat(32)}/hex`, () => new Response("zz"));
    return f.call("POST", `/vaults/${vaultId}/fund`, { txid: "ab".repeat(32), amount: "50000", costAccepted: true });
  }],
  ["input_not_found", 500, retry, (f) => f.call("POST", "/payment-input", { txid: previousTx(f), vout: 5, value: "70000" })],
  ["miner_request_failed", 500, retry, async (f) => {
    await resendable(f);
    const miner = slipstreamWith(() => new Response("", { status: 503 }));
    return f.call("POST", `/vaults/${vaultId}/fund/resubmit`, {}, { app: { miner } });
  }],
  ["miner_request_failed", 500, retry, async (f) => {
    await resendable(f);
    const miner = slipstreamWith(() => {
      throw new TypeError("fetch failed");
    });
    return f.call("POST", `/vaults/${vaultId}/fund/resubmit`, {}, { app: { miner } });
  }],
  ["miner_request_failed", 400, "Invalid request", async (f) => {
    await resendable(f);
    const miner = slipstreamWith(() => Response.json({ transaction: {} }));
    return f.call("POST", `/vaults/${vaultId}/fund/resubmit`, {}, { app: { miner } });
  }],
  ["miner_unavailable", 500, retry, async (f) => {
    await f.putVault();
    const miner = new Slipstream("https://slipstream.mara.com", async () => {
      throw new Error("secret store down");
    });
    return f.call("POST", `/vaults/${vaultId}/fund/submit`, { rawTxHex: deposit(), amount: "50000", costAccepted: true }, { app: { miner } });
  }],
];

// Refusals whose status is new in this change. Each happens before any store write,
// reservation, workflow start, chain read or miner call.
describe("client refusals before any side effect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const watch = (f: Fixture) => {
    const writes = [vi.spyOn(f.store, "put"), vi.spyOn(f.store, "atomicPut"), vi.spyOn(f.store, "delete")];
    const reads = [vi.spyOn(f.chain, "raw"), vi.spyOn(f.chain, "unspent"), vi.spyOn(f.chain, "status")];
    const miner = Object.values(f.miner);
    return () => {
      for (const spy of [...writes, ...reads, ...miner]) expect(spy).not.toHaveBeenCalled();
    };
  };
  const expectRefusal = async (response: Response, status: number, code: ApiErrorCode, error: string) =>
    expect({ status: response.status, ...(await response.json()) }).toMatchObject({ status, code, error });
  it.each([
    ["POST", "/auth/challenge"],
    ["POST", "/auth/verify"],
    ["POST", "/payment-input"],
    ["POST", "/vaults"],
    ["POST", `/vaults/${vaultId}/fund`],
    ["POST", `/vaults/${vaultId}/fund/submit`],
    ["POST", "/jobs"],
    ["POST", `/jobs/${jobId}/submit`],
  ] as const)("refuses malformed JSON on %s %s with 400 invalid_request", async (method, path) => {
    const f = await setup();
    await f.putVault(confirmedVault);
    await f.putJob({ solution });
    const untouched = watch(f);
    await expectRefusal(await f.call(method, path, undefined, { raw: "{" }), 400, "invalid_request", "Invalid request");
    untouched();
  });
  it("still answers a streamed body over the limit with 413", async () => {
    const f = await setup();
    const response = await f.call("POST", "/jobs", undefined, { stream: JSON.stringify({ ...manifest, destination: "x".repeat(200_000) }) });
    await expectRefusal(response, 413, "request_too_large", "Request is too large");
  });
  it("refuses a vault whose public state fails validation with 400 vault_invalid", async () => {
    const f = await setup();
    const untouched = watch(f);
    for (const publicStateJson of ["not json", JSON.stringify({ config: "A", secret: "x" }), JSON.stringify({ config: "B", full_script_hex: scriptHex })])
      await expectRefusal(await f.call("POST", "/vaults", vault({ publicStateJson })), 400, "vault_invalid", "Vault public state or configuration is invalid.");
    untouched();
  });
  it("refuses a withdrawal to an address that doesn't decode with 400 withdrawal_invalid", async () => {
    const f = await setup();
    await f.putVault(confirmedVault);
    const untouched = watch(f);
    const response = await f.call("POST", "/jobs", { ...manifest, destination: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx" });
    await expectRefusal(response, 400, "withdrawal_invalid", "Destination script mismatch.");
    untouched();
    expect(await f.store.list(pk, "JOB#")).toEqual([]);
  });
  it("codes an oversized deposit as funding_transaction_invalid, before any read, write or POST", async () => {
    const f = await setup();
    await f.putVault();
    const untouched = watch(f);
    const large = btc.Transaction.fromRaw(hex.decode(deposit()), opts);
    large.addOutput({ amount: 1n, script: new Uint8Array(76_000) });
    const rawTxHex = hex.encode(large.toBytes(true, false));
    expect(rawTxHex.length).toBeGreaterThan(150_000);
    const response = await f.call("POST", `/vaults/${vaultId}/fund/submit`, { rawTxHex, amount: "50000", costAccepted: true });
    await expectRefusal(response, 409, "funding_transaction_invalid", "ExactSpendMismatch");
    untouched();
  });
});

describe("API error codes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it.each(cases)("returns %s with HTTP %i", async (code, status, run) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await setup();
    const response = await run(f);
    const body = await response.json();
    expect({ status: response.status, code: body.code }).toEqual({ status, code });
    expect(body.error).toEqual(expect.any(String));
    if (code === "invalid_request") expect(body.issues).toEqual(expect.any(Array));
    if (code === "operations_disabled") expect(body.checks).toEqual(expect.any(Array));
  });
  it.each(unchanged)("returns %s with the unchanged HTTP %i and message %j", async (code, status, error, run) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await run(await setup());
    const body = await response.json();
    expect({ status: response.status, code: body.code, error: body.error }).toEqual({ status, code, error });
    if (status === 400) expect(body.issues).toEqual(expect.any(Array));
  });
  it("attaches a code without changing the error callers catch", async () => {
    const f = await setup();
    f.routes.set("/block-height/0", () => {
      throw new TypeError("fetch failed");
    });
    const transport = await f.chain.assertNetwork().catch((e: unknown) => e);
    expect(transport).toBeInstanceOf(TypeError);
    expect(transport).not.toBeInstanceOf(ChainError);
    expect(attachedApiErrorCode(transport)).toBe("chain_unavailable");
    genesis(f);
    f.routes.set(`/tx/${"ab".repeat(32)}/status`, () => new Response("{}"));
    const malformed = await f.chain.status("ab".repeat(32)).catch((e: unknown) => e);
    expect(malformed).toBeInstanceOf(z.ZodError);
    expect(attachedApiErrorCode(malformed)).toBe("chain_error");
    const inner = new Error("inner");
    expect(() => withApiErrorCode("chain_error", () => withApiErrorCode("chain_unavailable", () => {
      throw inner;
    }))).toThrow(inner);
    expect(attachedApiErrorCode(inner)).toBe("chain_unavailable");
  });
  it("drives every listed code, and the list has no duplicates", () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
    const driven = [...cases.map(([code]) => code), ...unchanged.map(([code]) => code)];
    expect([...new Set(driven)].sort()).toEqual([...API_ERROR_CODES].sort());
  });
  it("lists every code once in docs/API.md", () => {
    const doc = readFileSync(new URL("../docs/API.md", import.meta.url), "utf8");
    const listed = [...doc.matchAll(/^\|.*\|$/gm)].flatMap(([row]) =>
      [...row.matchAll(/`([a-z_]+)`/g)].map(([, code]) => code),
    );
    expect(listed.sort()).toEqual([...API_ERROR_CODES].sort());
  });
  it("sends every error body in the default routes through apiError", () => {
    // Any c.json/c.text/c.body/c.html with an error status or an `error` field, a non-literal
    // status, or a hand-built Response would bypass the codes.
    const offenders: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && node.expression.getText() === "Response")
        offenders.push(node.getText());
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText() === "c" &&
        ["json", "text", "body", "html", "newResponse"].includes(node.expression.name.text)
      ) {
        const [body, status] = node.arguments;
        const errorField =
          body &&
          ts.isObjectLiteralExpression(body) &&
          body.properties.some((p) => p.name?.getText() === "error");
        const errorStatus =
          status && !(ts.isNumericLiteral(status) && Number(status.text) < 400);
        if (errorField || errorStatus) offenders.push(node.getText());
      }
      ts.forEachChild(node, visit);
    };
    visit(parse("server/app.ts"));
    expect(offenders).toEqual([]);
  });
  it("keeps each error site's status, code and message", async () => {
    // A changed code or message at any site fails here. Review a deliberate change, then
    // update the list with `npx vitest run tests/api-errors.test.ts -u`.
    await expect(JSON.stringify(errorSites(), null, 2) + "\n").toMatchFileSnapshot("./api-error-sites.json");
  });
});
