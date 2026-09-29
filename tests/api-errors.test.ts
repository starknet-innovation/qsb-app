import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  };
  const call = (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: { auth?: string | null; app?: Partial<typeof deps>; raw?: string } = {},
  ) => {
    const auth = options.auth === undefined ? token : options.auth;
    return createApp(store, { ...deps, ...options.app }).request(
      new Request("http://localhost/api" + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: "Bearer " + auth } : {}),
        },
        body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
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
/** A confirmed-looking previous transaction with one 70000 sat output to the owner, served by the chain. */
const previousTx = (f: Fixture) => {
  const previous = new btc.Transaction(opts);
  previous.addInput({ txid: new Uint8Array(32).fill(5), index: 0 });
  previous.addOutputAddress(owner, 70_000n, BITCOIN_NETWORK);
  genesis(f);
  f.routes.set(`/tx/${previous.id}/hex`, () => new Response(hex.encode(previous.toBytes(true, true))));
  return previous.id;
};

// Each case drives one error path. Together they cover every listed code.
const cases: [ApiErrorCode, number, (f: Fixture) => Response | Promise<Response>][] = [
  ["invalid_request", 400, (f) => f.call("POST", "/auth/challenge", {})],
  ["request_too_large", 413, (f) => f.call("POST", "/auth/challenge", { address: "x".repeat(200_000) })],
  ["internal_error", 500, (f) => f.call("POST", "/auth/challenge", undefined, { raw: "{" })],
  ["network_mismatch", 400, (f) => f.call("POST", "/auth/challenge", { address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx" })],
  ["challenge_expired", 401, (f) => f.call("POST", "/auth/verify", { id: other, signature: "aa" })],
  ["signature_invalid", 401, async (f) => {
    const { id } = await (await f.call("POST", "/auth/challenge", { address: owner })).json();
    return f.call("POST", "/auth/verify", { id, signature: "aa" });
  }],
  ["auth_required", 401, (f) => f.call("GET", "/vaults", undefined, { auth: null })],
  ["session_expired", 401, (f) => f.call("GET", "/vaults", undefined, { auth: "B".repeat(43) })],
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
  ["input_unavailable", 409, (f) => f.call("POST", "/payment-input", { txid: previousTx(f), vout: 0, value: "69999" })],
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
    await f.putJob();
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
  ["input_unavailable", 500, retry, (f) => f.call("POST", "/payment-input", { txid: previousTx(f), vout: 5, value: "70000" })],
];

describe("API error codes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
    expect([...new Set(cases.map(([code]) => code))].sort()).toEqual([...API_ERROR_CODES].sort());
  });
  it("lists every code once in docs/API.md", () => {
    const doc = readFileSync(new URL("../docs/API.md", import.meta.url), "utf8");
    const listed = [...doc.matchAll(/^\|.*\|$/gm)].flatMap(([row]) =>
      [...row.matchAll(/`([a-z_]+)`/g)].map(([, code]) => code),
    );
    expect(listed.sort()).toEqual([...API_ERROR_CODES].sort());
  });
  it("leaves no error body without a code in the default routes", () => {
    const source = readFileSync(new URL("../server/app.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/c\.json\(\s*\{\s*error\s*:/);
  });
});
