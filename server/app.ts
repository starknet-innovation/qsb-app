import { deployedSolver, deployedSolverId } from "./solver-deployment";
import { observeWithdrawal } from "./withdrawal-status";
import { submitExact, SubmitDisabled } from "./submit-exact";
import { exportFunding, submitFunding } from "./submit-funding";
import {
  CoreConsensus,
  ConsensusError,
  type ConsensusVerifier,
} from "./consensus";
import { exactSubmitEnabled } from "./exact-submit-permit";
import { mainnetUiConfig, type MainnetUiOptions } from "./mainnetConfig";
import { apiError, attachedApiErrorCode } from "./api-errors";
import {
  CHALLENGE_SECONDS,
  SESSION_SECONDS,
  challengeRequest,
  fundRequest,
  fundResubmitRequest,
  fundSubmitRequest,
  submitRequest,
  transactionIdParam,
  verifyRequest,
} from "./api-schemas";
import {
  assertVaultConfiguration,
  pinSolver,
  solverRelease,
  vaultConfiguration,
} from "../src/lib/provenance";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Verifier } from "bip322-js";
import { z } from "zod";
import {
  publicVaultSchema,
  withdrawalSchema,
  validatePublicState,
  release,
  type Job,
  type PublicVault,
  outpoint,
} from "../src/lib/model";
import { Conflict, store as defaultStore, type Store } from "./store";
import { slipstream, MinerAuthenticationError } from "./providers";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { chain, ChainError, ChainNotFound, type Esplora } from "./chain";
import { matchVaultFunding } from "./transaction-checks";
import { coordinatorPublicSolvedResult } from "../src/mainnet/coordinatorResult";
import { outputScript } from "../src/lib/transactions";
import { hex } from "@scure/base";
import { NETWORK_ID } from "../src/lib/network";
import { transactionsEnabled, rehearsalAddressAllowed } from "./network";
import type { FundingLedger } from "./runtime/dispatcher";
import { canonicalReservationWrites } from "./runtime/storage-authority";
import {
  coverageAccountStopped,
  coverageLedgerSchema,
} from "./runtime/coverage-ledger";
import { installSupervisedRoutes } from "./runtime/supervised-routes";
import {
  MinerInclusionError,
  judgeInclusionEvidence,
  reportEsploraInclusion,
} from "./runtime/miner-inclusion";
const workflowClient = new SFNClient({ region: process.env.AWS_REGION });
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// A thrown ZodError built by parse (unlike `new z.ZodError`) is an Error, which Hono's onError needs.
const notJson = z.custom<never>(() => false, "Request body is not valid JSON.");
/** The request's JSON body. Malformed JSON is a 400 invalid_request, like a schema failure. */
async function jsonBody(c: { req: { json(): Promise<unknown> } }) {
  try {
    return await c.req.json();
  } catch (error) {
    // Only a syntax error: a body over the limit must still reach bodyLimit's 413.
    if (!(error instanceof SyntaxError)) throw error;
    return notJson.parse(undefined);
  }
}
function supervisedServiceJob(job: unknown): boolean {
  if (!job || typeof job !== "object") return false;
  const execution = (job as { execution?: { kind?: string } }).execution;
  return execution?.kind === "qsb-supervised-service-v1";
}
type Env = { Variables: { owner: string } };
export type AuthenticatedJobRoutes = Pick<Hono<Env>, "get">;
export type AuthenticatedJobPostRoutes = Pick<Hono<Env>, "post">;
export function createApp(
  store: Store = defaultStore,
  dependencies: {
    chain?: Esplora;
    miner?: typeof slipstream;
    enabled?: boolean;
    exactSubmit?: boolean;
    consensus?: ConsensusVerifier;
    mainnetUi?: MainnetUiOptions;
    // Trusted server wiring only; routes under /api/jobs inherit the auth middleware.
    installAuthenticatedJobRoutes?: (routes: AuthenticatedJobRoutes) => void;
    installAuthenticatedJobPostRoutes?: (
      routes: AuthenticatedJobPostRoutes,
    ) => void;
    /** Test-only in-process handoff. The default app does not admit jobs. */
    inProcessHandoff?: boolean;
    /** Injected chain reads for supervised admission. Never the process-wide client by default. */
    fundingLedger?: FundingLedger;
  } = {},
) {
  const ledger = dependencies.chain || chain,
    miner = dependencies.miner || slipstream;
  const enabled = dependencies.enabled ?? transactionsEnabled;
  const mainnetUiOptions = { ...dependencies.mainnetUi };
  const mainnetUiRoutes = { creation: false, admission: false };
  async function startWorkflow(job: Job) {
    if (!process.env.WORKFLOW_ARN) return;
    try {
      await workflowClient.send(
        new StartExecutionCommand({
          stateMachineArn: process.env.WORKFLOW_ARN,
          name: `${job.id}-r${job.revision}`,
          input: JSON.stringify({
            owner: job.owner,
            jobId: job.id,
            revision: job.revision,
          }),
        }),
      );
    } catch (e) {
      if ((e as Error).name !== "ExecutionAlreadyExists") throw e;
    }
  }
  const app = new Hono<Env>();
  const origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 160000,
      onError: (c) =>
        apiError(c, 413, "request_too_large", "Request is too large"),
    }),
  );
  app.onError((e, c) => {
    // A code attached at a boundary (a chain or miner provider, a deposit's bytes) keeps
    // the status and body its error class gets here.
    const attached = attachedApiErrorCode(e);
    if (e instanceof SubmitDisabled)
      return apiError(c, 503, "submit_disabled", e.message);
    if (e instanceof ConsensusError)
      return apiError(c, 409, "consensus_rejected", e.message);
    if (e instanceof MinerAuthenticationError)
      return apiError(c, 503, "miner_unavailable", e.message);
    // Its message is already a code; only ExactSpendMismatch has its own.
    if (e instanceof MinerInclusionError)
      return apiError(
        c,
        409,
        attached ??
          (e.message === "ExactSpendMismatch"
            ? "exact_spend_mismatch"
            : "inclusion_check_failed"),
        e.message,
      );
    if (e instanceof ChainError) return apiError(c, 409, e.code, e.message);
    if (e instanceof z.ZodError)
      return apiError(c, 400, attached ?? "invalid_request", "Invalid request", {
        issues: e.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    if (e instanceof Conflict)
      return apiError(
        c,
        409,
        "state_conflict",
        "State changed. Refresh and try again.",
      );
    console.error(JSON.stringify({ error: e.name, route: c.req.path }));
    return apiError(
      c,
      500,
      attached ?? "internal_error",
      "Unable to complete the request. Please retry.",
    );
  });
  app.get("/api/health", (c) => c.json({ ok: true, network: NETWORK_ID }));
  app.get("/api/config", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      ...release,
      ...(await mainnetUiConfig(
        store,
        NETWORK_ID,
        mainnetUiOptions,
        mainnetUiRoutes,
      )),
      network: NETWORK_ID,
      mainnetEnabled: NETWORK_ID === "mainnet" && enabled,
      operationsEnabled: enabled,
      solverReleaseId: deployedSolverId(),
      exactSubmitEnabled: dependencies.exactSubmit ?? exactSubmitEnabled(),
      billing: "not_configured",
      awsRegion: process.env.AWS_REGION || "local",
      maxBtc: null,
      withdrawalDeadline: null,
      computeBudget: null,
    });
  });
  app.get("/api/rates", async (c) => {
    try {
      return c.json(await miner.rates());
    } catch {
      return apiError(
        c,
        503,
        "miner_rate_unavailable",
        "Live miner fee quote is temporarily unavailable.",
      );
    }
  });
  app.post("/api/auth/challenge", async (c) => {
    const { address } = challengeRequest.parse(await jsonBody(c));
    try {
      outputScript(address);
    } catch {
      return apiError(
        c,
        400,
        "network_mismatch",
        "Wallet address does not match this Bitcoin network.",
      );
    }
    const id = randomUUID(),
      expiresAt = Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS;
    const message = `QSB Vault sign-in\nOrigin: ${origin}\nAddress: ${address}\nNetwork: bitcoin-${NETWORK_ID}\nNonce: ${id}\nExpires: ${new Date(expiresAt * 1000).toISOString()}\nThis signature authorizes this session only. It does not authorize a Bitcoin transaction.`;
    await store.put({
      pk: `CHALLENGE#${id}`,
      sk: "AUTH",
      version: 0,
      address,
      network: NETWORK_ID,
      message,
      expiresAt,
    });
    return c.json({ id, message });
  });
  app.post("/api/auth/verify", async (c) => {
    const { id, signature } = verifyRequest.parse(await jsonBody(c));
    const challenge = await store.get(`CHALLENGE#${id}`, "AUTH");
    if (!challenge || challenge.network !== NETWORK_ID)
      return apiError(
        c,
        401,
        "challenge_expired",
        "Sign-in request expired or already used.",
      );
    let valid = false;
    try {
      valid = Verifier.verifySignature(
        challenge.address as string,
        challenge.message as string,
        signature,
        true,
      );
    } catch {}
    if (!valid)
      return apiError(
        c,
        401,
        "signature_invalid",
        "Wallet signature is not valid.",
      );
    await store.delete(challenge.pk, challenge.sk, challenge.version);
    const token = randomBytes(32).toString("base64url");
    await store.put({
      pk: `SESSION#${hash(token)}`,
      sk: "AUTH",
      version: 0,
      owner: challenge.address,
      network: NETWORK_ID,
      expiresAt: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
    });
    return c.json({ token });
  });
  app.use("/api/vaults/*", auth);
  app.use("/api/vaults", auth);
  app.use("/api/transactions/*", auth);
  app.use("/api/jobs/*", auth);
  app.use("/api/jobs", auth);
  app.use("/api/payment-utxos", auth);
  app.use("/api/payment-input", auth);
  async function auth(c: any, next: () => Promise<void>) {
    const bearer = c.req.header("Authorization") || "";
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer))
      return apiError(
        c,
        401,
        "auth_required",
        "Connect and sign in with Xverse.",
      );
    const session = await store.get(`SESSION#${hash(bearer.slice(7))}`, "AUTH");
    if (!session || session.network !== NETWORK_ID)
      return apiError(
        c,
        401,
        "session_expired",
        "Session expired. Please reconnect.",
      );
    c.set("owner", session.owner);
    await next();
  }
  app.get("/api/vaults", async (c) => {
    const rows = await store.list(`OWNER#${c.get("owner")}`, "VAULT#");
    return c.json({
      vaults: rows.map((r) => r.vault),
      // Vaults whose unconfirmed deposit the server can resend: stored Slipstream bytes only.
      resendable: rows
        .filter(
          (r) =>
            typeof r.fundingRawTxHex === "string" &&
            r.fundingRawTxHex !== "" &&
            (r.vault as PublicVault).status === "submitted",
        )
        .map((r) => (r.vault as PublicVault).id),
    });
  });
  app.get("/api/payment-utxos", async (c) =>
    c.json({ utxos: await ledger.paymentUtxos(c.get("owner")) }),
  );
  app.post("/api/payment-input", async (c) => {
    const point = outpoint.parse(await jsonBody(c));
    return c.json(
      await ledger.unspent(point, hex.encode(outputScript(c.get("owner")))),
    );
  });
  app.post("/api/vaults", async (c) => {
    const vault = publicVaultSchema.parse(await jsonBody(c));
    if (
      vault.network !== NETWORK_ID ||
      vault.paymentAddress !== c.get("owner") ||
      vault.funding ||
      vault.status !== "unfunded"
    )
      return apiError(
        c,
        400,
        "vault_invalid",
        "Invalid vault ownership or funding state.",
      );
    // These check the request's own public state, before any write, so a refusal is a 400.
    let publicState;
    try {
      validatePublicState(vault.publicStateJson);
      assertVaultConfiguration(vault);
      vault.configuration ??= vaultConfiguration(vault);
      publicState = JSON.parse(vault.publicStateJson);
    } catch {
      return apiError(
        c,
        400,
        "vault_invalid",
        "Vault public state or configuration is invalid.",
      );
    }
    if (
      publicState.full_script_hex !== vault.scriptHex ||
      createHash("sha256")
        .update(Buffer.from(vault.scriptHex, "hex"))
        .digest("hex") !== vault.scriptHash
    )
      return apiError(
        c,
        400,
        "vault_invalid",
        "Vault script does not match its commitment.",
      );
    await store.put({
      pk: `OWNER#${c.get("owner")}`,
      sk: `VAULT#${vault.id}`,
      version: 0,
      vault,
    });
    return c.json({ vault }, 201);
  });
  app.post("/api/vaults/:id/fund", async (c) => {
    if (!enabled || !rehearsalAddressAllowed(c.get("owner")))
      return apiError(
        c,
        503,
        "operations_disabled",
        `${NETWORK_ID} funding is disabled pending validation and operator configuration.`,
        { checks: release.checks },
      );
    const body = fundRequest.parse(await jsonBody(c));
    const pk = `OWNER#${c.get("owner")}`,
      sk = `VAULT#${c.req.param("id")}`;
    const row = await store.get(pk, sk);
    if (!row) return apiError(c, 404, "vault_not_found", "Vault not found");
    const vault = row.vault as PublicVault;
    if (vault.network !== NETWORK_ID)
      return apiError(
        c,
        409,
        "network_mismatch",
        "Vault belongs to a different Bitcoin network.",
      );
    if (vault.status !== "unfunded" || vault.funding)
      return apiError(
        c,
        409,
        "funding_intent_exists",
        "Vault already has a funding intent. Reconcile that transaction first.",
      );
    assertVaultConfiguration(vault);
    // Xverse already broadcast this deposit. Read it from the chain provider
    // and record vault.funding only when output 0 pays this vault the expected
    // amount. Keep unconfirmed payments submitted. Do not submit it again.
    // The 10000 USD vault ceiling stays policy; it does not enable mainnet
    // or authorize a broadcast.
    const watched = await ledger.raw(body.txid);
    const payment = matchVaultFunding(
      watched.tx,
      vault.scriptHex,
      BigInt(body.amount),
    );
    const chainStatus = await ledger.status(watched.tx.id);
    vault.funding = {
      txid: watched.tx.id,
      vout: payment.vout,
      value: payment.value,
    };
    vault.status = chainStatus.confirmed ? "confirmed" : "submitted";
    await store.put({ ...row, vault, version: row.version + 1 }, row.version);
    return c.json({ vault }, 201);
  });
  // Deposits pay a bare, non-standard QSB script that public relay refuses, so the signed
  // deposit is submitted to MARA Slipstream. The intent is recorded before the POST.
  app.post("/api/vaults/:id/fund/submit", async (c) => {
    if (!enabled || !rehearsalAddressAllowed(c.get("owner")))
      return apiError(
        c,
        503,
        "operations_disabled",
        `${NETWORK_ID} funding is disabled pending validation and operator configuration.`,
      );
    if (!(dependencies.exactSubmit ?? exactSubmitEnabled()))
      return apiError(
        c,
        503,
        "submit_disabled",
        "Deposit submission to the miner is disabled.",
      );
    const body = fundSubmitRequest.parse(await jsonBody(c));
    const result = await submitFunding(
      c.get("owner"),
      c.req.param("id"),
      body.rawTxHex,
      BigInt(body.amount),
      { store, miner, enabled: dependencies.exactSubmit ?? exactSubmitEnabled() },
    );
    // 201 for every outcome: `submission` says whether MARA accepted, refused or is unknown.
    return c.json(result, 201);
  });
  // The stored signed deposit, for manual submission on slipstream.mara.com. No chain lookup,
  // so it works while the chain API is down. It's offered only while deposits are switched on,
  // so disabling submission during an incident also stops the manual path.
  app.get("/api/vaults/:id/fund/signed", async (c) => {
    if (!enabled || !rehearsalAddressAllowed(c.get("owner")) || !(dependencies.exactSubmit ?? exactSubmitEnabled()))
      return apiError(
        c,
        503,
        "submit_disabled",
        "Deposit submission is switched off.",
      );
    const row = await exportFunding(store, c.get("owner"), c.req.param("id"));
    if (!row)
      return apiError(
        c,
        404,
        "signed_deposit_not_found",
        "This vault has no stored signed deposit.",
      );
    const vault = row.vault as PublicVault;
    return c.json({
      txid: vault.funding!.txid,
      rawTxHex: row.fundingRawTxHex,
      status: vault.status,
      submission: row.fundingSubmission,
    });
  });
  // Resend a stored Slipstream deposit, exactly the same bytes, e.g. after an unknown
  // outcome and a reload. It can only confirm once; a second deposit is never created.
  app.post("/api/vaults/:id/fund/resubmit", async (c) => {
    if (!enabled || !rehearsalAddressAllowed(c.get("owner")))
      return apiError(
        c,
        503,
        "operations_disabled",
        `${NETWORK_ID} funding is disabled pending validation and operator configuration.`,
      );
    if (!(dependencies.exactSubmit ?? exactSubmitEnabled()))
      return apiError(
        c,
        503,
        "submit_disabled",
        "Deposit submission to the miner is disabled.",
      );
    fundResubmitRequest.parse(await c.req.json().catch(() => ({})));
    const row = await store.get(`OWNER#${c.get("owner")}`, `VAULT#${c.req.param("id")}`);
    if (!row) return apiError(c, 404, "vault_not_found", "Vault not found");
    const vault = row.vault as PublicVault;
    if (!vault.funding || typeof row.fundingRawTxHex !== "string" || !row.fundingRawTxHex)
      return apiError(
        c,
        409,
        "signed_deposit_not_found",
        "This vault has no stored Slipstream deposit to resend.",
      );
    const result = await submitFunding(
      c.get("owner"),
      c.req.param("id"),
      row.fundingRawTxHex,
      BigInt(vault.funding.value),
      { store, miner, enabled: dependencies.exactSubmit ?? exactSubmitEnabled() },
    );
    return c.json(result, 201);
  });
  // Reconcile the durable intent without submitting it again. Private miner
  // visibility is distinct from independent canonical-chain confirmation.
  app.get("/api/transactions/:id/status", async (c) => {
    const id = transactionIdParam.parse(c.req.param("id"));
    const pk = `OWNER#${c.get("owner")}`;
    const row = await store.get(pk, `TX#${id}`);
    if (!row)
      return apiError(
        c,
        404,
        "intent_not_found",
        "Transaction intent not found",
      );
    const observation = await observeWithdrawal(row, ledger, miner);
    const onChain = observation.chain;
    const inMiner = observation.miner;
    const status = observation.status;
    const checkedAt = new Date().toISOString();
    // A missing record or unavailable provider is not proof of rejection. Keep
    // the signed intent and input reservations even if neither can see it yet.
    await store.put(
      {
        ...row,
        ...(observation.chainUnavailable
          ? {}
          : {
              status,
              alert: observation.alert ?? null,
              includedTxid: observation.includedTxid,
            }),
        checkedAt,
        version: row.version + 1,
      },
      row.version,
    );
    const actualTxid =
      onChain && "txid" in onChain && typeof onChain.txid === "string"
        ? onChain.txid
        : id;
    const judgment = judgeInclusionEvidence({
      ...(inMiner
        ? {
            httpStatus: 200,
            minerReportedConfirmed: inMiner.transaction.status.confirmed,
          }
        : {}),
      ...(onChain
        ? {
            chain: {
              confirmed: onChain.confirmed,
              confirmations: onChain.confirmations,
              ...("blockHash" in onChain && onChain.blockHash
                ? { blockHash: onChain.blockHash }
                : {}),
              ...("blockHeight" in onChain && onChain.blockHeight !== undefined
                ? { blockHeight: onChain.blockHeight }
                : {}),
              txid: actualTxid,
            },
          }
        : {}),
      expectedTxid: actualTxid,
    });
    // A fulfilled ledger.status call is this route's Esplora query. The
    // report uses its own reason and limits when that query confirms.
    const section7Inclusion = reportEsploraInclusion(
      judgment,
      onChain !== null,
    );
    return c.json({
      txid: id,
      includedTxid: observation.includedTxid,
      chainUnavailable: observation.chainUnavailable,
      status,
      checkedAt,
      chain: onChain,
      miner: inMiner
        ? {
            visible: true,
            reportedConfirmed: inMiner.transaction.status.confirmed,
          }
        : { visible: null },
      alert: observation.alert,
      retrySafe: false,
      section7Inclusion,
    });
  });
  app.get("/api/vaults/:id/funding", async (c) => {
    const pk = `OWNER#${c.get("owner")}`,
      sk = `VAULT#${c.req.param("id")}`,
      row = await store.get(pk, sk);
    if (!row) return apiError(c, 404, "vault_not_found", "Vault not found");
    const vault = row.vault as PublicVault;
    if (vault.network !== NETWORK_ID)
      return apiError(
        c,
        409,
        "network_mismatch",
        "Vault belongs to a different Bitcoin network.",
      );
    if (!vault.funding)
      return apiError(c, 409, "vault_not_funded", "Vault is not funded");
    // A Slipstream deposit isn't visible to the public chain API until it is mined. The
    // stored signed bytes stand in until then; they never count as confirmation.
    const stored =
      typeof row.fundingRawTxHex === "string" && row.fundingRawTxHex ? row.fundingRawTxHex : undefined;
    // Only a definitive 404 falls back; provider failures (429, 5xx, network) propagate.
    const unseen = (error: unknown) => stored !== undefined && error instanceof ChainNotFound;
    let fromChain = true;
    const status = await ledger.status(vault.funding.txid).catch((error) => {
      if (!unseen(error)) throw error;
      fromChain = false;
      return { confirmed: false, confirmations: 0 };
    });
    // The fallback never changes the vault's durable status.
    if (vault.status !== "spent" && fromChain) {
      const next = status.confirmed ? "confirmed" : "submitted";
      if (next !== vault.status) {
        vault.status = next;
        await store.put(
          { ...row, vault, version: row.version + 1 },
          row.version,
        );
      }
    }
    return c.json({
      vault,
      status,
      ...(stored ? { submission: row.fundingSubmission } : {}),
      ...(await ledger
        .raw(vault.funding.txid)
        .then((x) => ({ previousTxHex: x.raw }))
        .catch(async (error) => {
          if (!unseen(error)) throw error;
          const exported = await exportFunding(store, c.get("owner"), vault.id, stored);
          if (!exported) throw new ChainError("Funding intent changed during export. Refresh the vault.", "state_conflict");
          return { previousTxHex: exported.fundingRawTxHex as string };
        })),
    });
  });
  app.get("/api/jobs", async (c) =>
    c.json({
      jobs: (await store.list(`OWNER#${c.get("owner")}`, "JOB#")).map(
        (r) => r.job,
      ),
    }),
  );
  app.get("/api/jobs/:id/solved-result", async (c) => {
    c.header("Cache-Control", "no-store");
    if (NETWORK_ID !== "mainnet")
      return apiError(
        c,
        404,
        "solved_result_unavailable",
        "Solved results are delivered on Bitcoin mainnet.",
      );
    const row = await store.get(
      `OWNER#${c.get("owner")}`,
      `JOB#${c.req.param("id")}`,
    );
    if (!row) return apiError(c, 404, "job_not_found", "Job not found");
    const job = row.job as Job;
    if (job.owner !== c.get("owner"))
      return apiError(c, 404, "job_not_found", "Job not found");
    if (supervisedServiceJob(job))
      return apiError(
        c,
        409,
        "job_unsupported",
        "Supervised jobs are not delivered by the coordinator result.",
      );
    try {
      return c.json(coordinatorPublicSolvedResult(job));
    } catch {
      return apiError(
        c,
        404,
        "solved_result_unavailable",
        "Solved result is not available.",
      );
    }
  });
  app.post("/api/jobs", async (c) => {
    const manifest = withdrawalSchema.parse(await jsonBody(c));
    if (!enabled || !rehearsalAddressAllowed(c.get("owner")))
      return apiError(
        c,
        503,
        "operations_disabled",
        `${NETWORK_ID} withdrawals are disabled pending validation and operator configuration.`,
      );
    const owner = c.get("owner"),
      pk = `OWNER#${owner}`,
      id = manifest.idempotencyKey,
      sk = `JOB#${id}`;
    const existing = await store.get(pk, sk);
    if (existing) {
      if ((existing.job as Job).manifestHash !== hash(JSON.stringify(manifest)))
        return apiError(
          c,
          409,
          "idempotency_conflict",
          "Idempotency key already belongs to another withdrawal.",
        );
      const storedJob = existing.job as Job;
      if (storedJob.status === "queued") {
        // Existing paid IDs, single or per parallel chunk, still need polling.
        let runnable =
          Boolean(storedJob.runpodId) ||
          Boolean(storedJob.parallelSlots?.some((s) => s.runpodId));
        if (!runnable && storedJob.solver) {
          try { deployedSolver(storedJob.solver.descriptor.id); runnable = true; } catch {}
        }
        if (runnable) await startWorkflow(storedJob);
      }
      return c.json({ job: existing.job });
    }
    const vault = await store.get(pk, `VAULT#${manifest.vaultId}`);
    if (!vault) return apiError(c, 404, "vault_not_found", "Vault not found");
    const v = vault.vault as PublicVault;
    if (v.network !== NETWORK_ID)
      return apiError(
        c,
        409,
        "network_mismatch",
        "Vault belongs to a different Bitcoin network.",
      );
    if (v.status !== "confirmed")
      return apiError(
        c,
        409,
        "vault_not_confirmed",
        "Vault funding is not confirmed.",
      );
    if (
      !v.funding ||
      (["txid", "vout", "value"] as const).some(
        (field) => v.funding![field] !== manifest.funding[field],
      )
    )
      return apiError(
        c,
        409,
        "withdrawal_invalid",
        "Funding outpoint does not match this vault.",
      );
    // An address that doesn't decode for this network has no script: the same 400, before
    // any reservation or chain read.
    let destinationScript: string | undefined;
    try {
      destinationScript = hex.encode(outputScript(manifest.destination));
    } catch {}
    if (destinationScript !== manifest.outputScript)
      return apiError(
        c,
        400,
        "withdrawal_invalid",
        "Destination script mismatch.",
      );
    if (BigInt(manifest.outputValue) <= 0n || BigInt(manifest.fee) <= 0n)
      return apiError(
        c,
        400,
        "withdrawal_invalid",
        "Output and fee must be positive.",
      );
    if (
      BigInt(manifest.funding.value) + BigInt(manifest.helper.value) !==
      BigInt(manifest.outputValue) + BigInt(manifest.fee)
    )
      return apiError(
        c,
        400,
        "withdrawal_invalid",
        "Transaction amounts do not balance.",
      );
    let selectedSolver: ReturnType<typeof deployedSolver>;
    try { selectedSolver = deployedSolver(manifest.solverReleaseId); }
    catch {
      return apiError(
        c,
        503,
        "solver_not_served",
        "The requested solver is not served by this deployment. No withdrawal was reserved.",
      );
    }
    await ledger.unspent(manifest.funding, v.scriptHex);
    await ledger.unspent(manifest.helper, hex.encode(outputScript(owner)));
    const now = new Date().toISOString();
    const job: Job = {
      id,
      owner,
      vaultId: manifest.vaultId,
      manifest,
      manifestHash: hash(JSON.stringify(manifest)),
      solver: pinSolver(v, selectedSolver.id),
      createdAt: now,
      updatedAt: now,
      status: "queued",
      stage: "pinning",
      attempt: 0,
      computeSeconds: 0,
      gpuBudgetReservedSeconds: 0,
      revision: 0,
    };
    await store.atomicPut([
      { row: { pk, sk, version: 0, job } },
      ...(await canonicalReservationWrites(
        store,
        [manifest.funding, manifest.helper].map((point) => ({
          owner,
          jobId: id,
          txid: point.txid,
          vout: point.vout,
        })),
      )),
    ]);
    await startWorkflow(job);
    return c.json({ job }, 201);
  });
  app.post("/api/jobs/:id/submit", async (c) => {
    if (!(dependencies.exactSubmit ?? exactSubmitEnabled()))
      return apiError(
        c,
        503,
        "submit_disabled",
        `${NETWORK_ID} withdrawals are disabled.`,
      );
    const body = submitRequest.parse(await jsonBody(c));
    const result = await submitExact(
      c.get("owner"),
      c.req.param("id"),
      body.rawTxHex,
      {
        store,
        chain: ledger,
        miner,
        consensus: dependencies.consensus ?? new CoreConsensus(),
        enabled: dependencies.exactSubmit ?? exactSubmitEnabled(),
      },
    );
    return c.json(result);
  });
  app.post("/api/jobs/:id/pause", async (c) => {
    const pk = `OWNER#${c.get("owner")}`,
      sk = `JOB#${c.req.param("id")}`;
    const r = await store.get(pk, sk);
    if (!r) return apiError(c, 404, "job_not_found", "Job not found");
    const job = r.job as Job;
    if (supervisedServiceJob(job))
      return apiError(
        c,
        409,
        "job_unsupported",
        "Supervised jobs are not controlled by this route.",
      );
    if (!["searching", "queued"].includes(job.status))
      return apiError(
        c,
        409,
        "job_state_invalid",
        "This job cannot be paused.",
      );
    const unknownPost = job.parallelSlots
      ? job.parallelSlots.some((s) => !s.runpodId)
      : !job.runpodId;
    if (job.status === "searching" && unknownPost)
      job.error =
        "Submission outcome unknown. Reconcile compute provider before resuming.";
    job.status = "paused";
    job.updatedAt = new Date().toISOString();
    await store.put({ ...r, version: r.version + 1, job }, r.version);
    return c.json({ job });
  });
  app.post("/api/jobs/:id/resume", async (c) => {
    if (!enabled || !rehearsalAddressAllowed(c.get("owner")))
      return apiError(
        c,
        503,
        "operations_disabled",
        `${NETWORK_ID} withdrawals are disabled.`,
      );
    const pk = `OWNER#${c.get("owner")}`,
      sk = `JOB#${c.req.param("id")}`,
      row = await store.get(pk, sk);
    if (!row) return apiError(c, 404, "job_not_found", "Job not found");
    const job = row.job as Job;
    if (supervisedServiceJob(job))
      return apiError(
        c,
        409,
        "job_unsupported",
        "Supervised jobs are not controlled by this route.",
      );
    if (job.status !== "paused")
      return apiError(
        c,
        409,
        "job_state_invalid",
        "Only a paused job can be resumed.",
      );
    const storedLedger = z
      .object({ coverageLedger: coverageLedgerSchema.optional() })
      .safeParse(row.validation);
    const solverPin = job.solver
      ? job.solver.descriptor.id
      : solverRelease("qsb-config-a-ranked-v2-2791ed0").id;
    if (
      storedLedger.success &&
      coverageAccountStopped(storedLedger.data.coverageLedger, {
        sessionId: `${c.get("owner")}/${job.id}`,
        solverPin,
      })
    )
      return apiError(
        c,
        409,
        "coverage_stopped",
        "Stopped coverage cannot be resumed on this account.",
      );
    if (
      job.error?.includes("Submission outcome unknown") &&
      !(
        job.oneSubmissionAllowed === true &&
        job.submissionReconciliation?.kind === "not-submitted" &&
        job.submissionReconciliation.revision === job.revision
      )
    )
      return apiError(
        c,
        409,
        "reconcile_required",
        "Reconcile the unknown compute provider submission before retrying.",
      );
    if (
      job.error?.includes("range exhausted") ||
      job.error?.includes("failed independent")
    )
      return apiError(
        c,
        409,
        "operator_review_required",
        "This failure needs operator review.",
      );
    job.status = "queued";
    job.retryRequested = true;
    job.revision++;
    job.updatedAt = new Date().toISOString();
    delete job.error;
    delete job.oneSubmissionAllowed;
    await store.put({ ...row, job, version: row.version + 1 }, row.version);
    await startWorkflow(job);
    return c.json({ job }, 202);
  });
  app.get("/api/jobs/:id/status", async (c) => {
    const pk = `OWNER#${c.get("owner")}`,
      sk = `JOB#${c.req.param("id")}`,
      row = await store.get(pk, sk);
    if (!row) return apiError(c, 404, "job_not_found", "Job not found");
    const job = row.job as Job;
    if (supervisedServiceJob(job))
      return apiError(
        c,
        409,
        "job_unsupported",
        "Supervised jobs are not controlled by this route.",
      );
    if (!job.txid) return c.json({ job });
    const intent = await store.get(pk, `TX#${job.txid}`);
    if (!intent)
      return apiError(
        c,
        404,
        "intent_not_found",
        "Transaction intent not found",
      );
    if (intent.kind === "exact-withdrawal" && intent.jobId !== job.id)
      return apiError(
        c,
        409,
        "intent_conflict",
        "Transaction intent belongs to a different job",
      );
    const observation =
      intent.kind === "exact-withdrawal"
        ? await observeWithdrawal(intent, ledger, miner)
        : undefined;
    if (observation?.chainUnavailable) {
      await store.put(
        {
          ...intent,
          version: intent.version + 1,
          checkedAt: new Date().toISOString(),
        },
        intent.version,
      );
      return c.json({
        job,
        status: null,
        submissionStatus: observation.status,
        alert: observation.alert,
        includedTxid: observation.includedTxid,
        chainUnavailable: true,
        retrySafe: false,
      });
    }
    if (observation && observation.status !== "confirmed") {
      await store.put(
        {
          ...intent,
          version: intent.version + 1,
          status: observation.status,
          alert: observation.alert ?? null,
          checkedAt: new Date().toISOString(),
        },
        intent.version,
      );
      if (job.status === "confirmed") {
        job.status = "submitted";
        await store.put({ ...row, job, version: row.version + 1 }, row.version);
      }
      return c.json({
        job,
        status: observation.chain,
        submissionStatus: observation.status,
        alert: observation.alert,
        retrySafe: false,
      });
    }
    const status = observation?.chain ?? (await ledger.status(job.txid));
    const includedTxid = status.confirmed
      ? "txid" in status && typeof status.txid === "string"
        ? status.txid
        : job.txid
      : undefined;
    const vaultRow = await store.get(pk, `VAULT#${job.vaultId}`);
    if (!vaultRow)
      return apiError(c, 404, "vault_not_found", "Vault not found");
    const vault = vaultRow.vault as PublicVault;
    job.status = status.confirmed ? "confirmed" : "submitted";
    vault.status = status.confirmed ? "spent" : "confirmed";
    job.updatedAt = new Date().toISOString();
    await store.atomicPut([
      { row: { ...row, job, version: row.version + 1 }, expected: row.version },
      {
        row: { ...vaultRow, vault, version: vaultRow.version + 1 },
        expected: vaultRow.version,
      },
    ]);
    // Keep job.txid bound to the durable original intent even when the mined
    // legacy scriptSig has a different transaction identifier.
    return c.json({ job, status, includedTxid });
  });
  const authenticatedGet = {
    get: ((path: string, ...handlers: any[]) => {
      if (path === "/api/jobs/:id/mainnet-solved-state" && handlers.length > 0)
        mainnetUiRoutes.admission = true;
      return (app.get.bind(app) as (...a: any[]) => any)(path, ...handlers);
    }) as typeof app.get,
  };
  const registeredPosts = new Set<string>();
  const authenticatedPost = {
    post: ((path: string, ...handlers: any[]) => {
      registeredPosts.add(path);
      if (path === "/api/jobs/supervised" && handlers.length > 0)
        mainnetUiRoutes.creation = true;
      return (app.post.bind(app) as (...a: any[]) => any)(path, ...handlers);
    }) as typeof app.post,
  };
  dependencies.installAuthenticatedJobRoutes?.(authenticatedGet);
  dependencies.installAuthenticatedJobPostRoutes?.(authenticatedPost);
  if (dependencies.inProcessHandoff === true) {
    installSupervisedRoutes(authenticatedGet, authenticatedPost, store, {
      post: !registeredPosts.has("/api/jobs/supervised"),
      ledger: dependencies.fundingLedger,
    });
  }
  return app;
}
export const app = createApp();
