import { mainnetUiConfig, type MainnetUiOptions } from "./mainnetConfig";
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
  sats,
  outpoint,
} from "../src/lib/model";
import { Conflict, store as defaultStore, type Store } from "./store";
import { slipstream, MinerAuthenticationError } from "./providers";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { chain, ChainError, type Esplora } from "./chain";
import { outputScript } from "../src/lib/transactions";
import { hex } from "@scure/base";
import { NETWORK_ID } from "../src/lib/network";
import {
  transactionsEnabled,
  rehearsalAddressAllowed,
  chainBase,
  minerBase,
} from "./network";
import type { FundingLedger } from "./runtime/dispatcher";
import { canonicalReservationWrites } from "./runtime/storage-authority";
import {
  coverageAccountStopped,
  coverageLedgerSchema,
} from "./runtime/coverage-ledger";
import { installSupervisedRoutes } from "./runtime/supervised-routes";
import {
  MinerInclusionError,
  assertMainnetTransportClosed,
  authorizeConfiguredSpend,
  callMinerSubmit,
  judgeInclusionEvidence,
  reportEsploraInclusion,
  transactionId,
} from "./runtime/miner-inclusion";
const workflowClient = new SFNClient({ region: process.env.AWS_REGION });
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
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
      onError: (c) => c.json({ error: "Request is too large" }, 413),
    }),
  );
  app.onError((e, c) => {
    if (e instanceof MinerAuthenticationError)
      return c.json({ error: e.message }, 503);
    if (e instanceof MinerInclusionError)
      return c.json({ error: e.message }, 409);
    if (e instanceof ChainError) return c.json({ error: e.message }, 409);
    if (e instanceof z.ZodError)
      return c.json(
        {
          error: "Invalid request",
          issues: e.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    if (e instanceof Conflict)
      return c.json({ error: "State changed. Refresh and try again." }, 409);
    console.error(JSON.stringify({ error: e.name, route: c.req.path }));
    return c.json(
      { error: "Unable to complete the request. Please retry." },
      500,
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
      operationsEnabled: enabled,
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
      return c.json(
        { error: "Live miner fee quote is temporarily unavailable." },
        503,
      );
    }
  });
  app.post("/api/auth/challenge", async (c) => {
    const { address } = z
      .object({ address: z.string().min(14).max(100) })
      .strict()
      .parse(await c.req.json());
    try {
      outputScript(address);
    } catch {
      return c.json(
        { error: "Wallet address does not match this Bitcoin network." },
        400,
      );
    }
    const id = randomUUID(),
      expiresAt = Math.floor(Date.now() / 1000) + 300;
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
    const { id, signature } = z
      .object({ id: z.string().uuid(), signature: z.string().max(4096) })
      .strict()
      .parse(await c.req.json());
    const challenge = await store.get(`CHALLENGE#${id}`, "AUTH");
    if (!challenge || challenge.network !== NETWORK_ID)
      return c.json({ error: "Sign-in request expired or already used." }, 401);
    let valid = false;
    try {
      valid = Verifier.verifySignature(
        challenge.address as string,
        challenge.message as string,
        signature,
        true,
      );
    } catch {}
    if (!valid) return c.json({ error: "Wallet signature is not valid." }, 401);
    await store.delete(challenge.pk, challenge.sk, challenge.version);
    const token = randomBytes(32).toString("base64url");
    await store.put({
      pk: `SESSION#${hash(token)}`,
      sk: "AUTH",
      version: 0,
      owner: challenge.address,
      network: NETWORK_ID,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
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
      return c.json({ error: "Connect and sign in with Xverse." }, 401);
    const session = await store.get(`SESSION#${hash(bearer.slice(7))}`, "AUTH");
    if (!session || session.network !== NETWORK_ID)
      return c.json({ error: "Session expired. Please reconnect." }, 401);
    c.set("owner", session.owner);
    await next();
  }
  app.get("/api/vaults", async (c) =>
    c.json({
      vaults: (await store.list(`OWNER#${c.get("owner")}`, "VAULT#")).map(
        (r) => r.vault,
      ),
    }),
  );
  app.get("/api/payment-utxos", async (c) =>
    c.json({ utxos: await ledger.paymentUtxos(c.get("owner")) }),
  );
  app.post("/api/payment-input", async (c) => {
    const point = outpoint.parse(await c.req.json());
    return c.json(
      await ledger.unspent(point, hex.encode(outputScript(c.get("owner")))),
    );
  });
  app.post("/api/vaults", async (c) => {
    const vault = publicVaultSchema.parse(await c.req.json());
    if (
      vault.network !== NETWORK_ID ||
      vault.paymentAddress !== c.get("owner") ||
      vault.funding ||
      vault.status !== "unfunded"
    )
      return c.json(
        { error: "Invalid vault ownership or funding state." },
        400,
      );
    validatePublicState(vault.publicStateJson);
    assertVaultConfiguration(vault);
    vault.configuration ??= vaultConfiguration(vault);
    const publicState = JSON.parse(vault.publicStateJson);
    if (
      publicState.full_script_hex !== vault.scriptHex ||
      createHash("sha256")
        .update(Buffer.from(vault.scriptHex, "hex"))
        .digest("hex") !== vault.scriptHash
    )
      return c.json(
        { error: "Vault script does not match its commitment." },
        400,
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
      return c.json(
        {
          error: `${NETWORK_ID} funding is disabled pending validation and operator configuration.`,
          checks: release.checks,
        },
        503,
      );
    const body = z
      .object({
        rawTxHex: z.string().max(150000),
        amount: sats,
        fee: sats,
        costAccepted: z.literal(true),
        spentFixtureRefs: z.array(z.unknown()).max(32).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const pk = `OWNER#${c.get("owner")}`,
      sk = `VAULT#${c.req.param("id")}`;
    const row = await store.get(pk, sk);
    if (!row) return c.json({ error: "Vault not found" }, 404);
    const vault = row.vault as PublicVault;
    if (vault.network !== NETWORK_ID)
      return c.json(
        { error: "Vault belongs to a different Bitcoin network." },
        409,
      );
    if (vault.status !== "unfunded" || vault.funding)
      return c.json(
        {
          error:
            "Vault already has a funding intent. Reconcile that transaction first.",
        },
        409,
      );
    assertVaultConfiguration(vault);
    // The requester cannot supply exactSpend, so this route cannot satisfy 7.3.
    const permit = authorizeConfiguredSpend({
      chain: NETWORK_ID,
      chainBaseUrl: chainBase,
      minerEndpoint: minerBase,
      rawTxHex: body.rawTxHex,
      txid: transactionId(body.rawTxHex),
      amountSats: body.amount,
      feeSats: body.fee,
      exactSpend: undefined,
      spentFixtureRefs: body.spentFixtureRefs ?? [],
      release,
      walletApp: "xverse",
    });
    // Refuse the live miner before any chain read, miner preflight, or saved
    // intent. callMinerSubmit rejects this endpoint without HTTP. A refusal
    // must not leave the vault looking funded.
    assertMainnetTransportClosed(permit, minerBase);
    await callMinerSubmit({
      permit,
      rawTxHex: body.rawTxHex,
      transport: { endpoint: minerBase },
    });
    throw new MinerInclusionError("LiveMinerTransportRefused");
  });
  // Reconcile the durable intent without submitting it again. Private miner
  // visibility is distinct from independent canonical-chain confirmation.
  app.get("/api/transactions/:id/status", async (c) => {
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(c.req.param("id"));
    const pk = `OWNER#${c.get("owner")}`;
    const row = await store.get(pk, `TX#${id}`);
    if (!row) return c.json({ error: "Transaction intent not found" }, 404);
    const [chainResult, minerResult] = await Promise.allSettled([
      ledger.status(id),
      miner.status(id),
    ]);
    const onChain =
      chainResult.status === "fulfilled" ? chainResult.value : null;
    const inMiner =
      minerResult.status === "fulfilled" ? minerResult.value : null;
    const status = onChain?.confirmed
      ? "confirmed"
      : onChain || inMiner
        ? "submitted"
        : "uncertain";
    const checkedAt = new Date().toISOString();
    // A missing record or unavailable provider is not proof of rejection. Keep
    // the signed intent and input reservations even if neither can see it yet.
    await store.put(
      { ...row, status, checkedAt, version: row.version + 1 },
      row.version,
    );
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
              ...("blockHeight" in onChain &&
              onChain.blockHeight !== undefined
                ? { blockHeight: onChain.blockHeight }
                : {}),
              txid: id,
            },
          }
        : {}),
      expectedTxid: id,
    });
    // A fulfilled ledger.status call is this route's Esplora query. The
    // report uses its own reason and limits when that query confirms.
    const section7Inclusion = reportEsploraInclusion(
      judgment,
      chainResult.status === "fulfilled",
    );
    return c.json({
      txid: id,
      status,
      checkedAt,
      chain: onChain,
      miner: inMiner
        ? {
            visible: true,
            reportedConfirmed: inMiner.transaction.status.confirmed,
          }
        : { visible: null },
      retrySafe: false,
      section7Inclusion,
    });
  });
  app.get("/api/vaults/:id/funding", async (c) => {
    const pk = `OWNER#${c.get("owner")}`,
      sk = `VAULT#${c.req.param("id")}`,
      row = await store.get(pk, sk);
    if (!row) return c.json({ error: "Vault not found" }, 404);
    const vault = row.vault as PublicVault;
    if (vault.network !== NETWORK_ID)
      return c.json(
        { error: "Vault belongs to a different Bitcoin network." },
        409,
      );
    if (!vault.funding) return c.json({ error: "Vault is not funded" }, 409);
    const status = await ledger.status(vault.funding.txid);
    if (vault.status !== "spent") {
      vault.status = status.confirmed ? "confirmed" : "submitted";
      await store.put({ ...row, vault, version: row.version + 1 }, row.version);
    }
    return c.json({
      vault,
      status,
      ...(await ledger
        .raw(vault.funding.txid)
        .then((x) => ({ previousTxHex: x.raw }))),
    });
  });
  app.get("/api/jobs", async (c) =>
    c.json({
      jobs: (await store.list(`OWNER#${c.get("owner")}`, "JOB#")).map(
        (r) => r.job,
      ),
    }),
  );
  app.post("/api/jobs", async (c) => {
    const manifest = withdrawalSchema.parse(await c.req.json());
    if (!enabled || !rehearsalAddressAllowed(c.get("owner")))
      return c.json(
        {
          error: `${NETWORK_ID} withdrawals are disabled pending validation and operator configuration.`,
        },
        503,
      );
    const owner = c.get("owner"),
      pk = `OWNER#${owner}`,
      id = manifest.idempotencyKey,
      sk = `JOB#${id}`;
    const existing = await store.get(pk, sk);
    if (existing) {
      if ((existing.job as Job).manifestHash !== hash(JSON.stringify(manifest)))
        return c.json(
          { error: "Idempotency key already belongs to another withdrawal." },
          409,
        );
      if ((existing.job as Job).status === "queued")
        await startWorkflow(existing.job as Job);
      return c.json({ job: existing.job });
    }
    const vault = await store.get(pk, `VAULT#${manifest.vaultId}`);
    if (!vault) return c.json({ error: "Vault not found" }, 404);
    const v = vault.vault as PublicVault;
    if (v.network !== NETWORK_ID)
      return c.json(
        { error: "Vault belongs to a different Bitcoin network." },
        409,
      );
    if (
      !v.funding ||
      (["txid", "vout", "value"] as const).some(
        (field) => v.funding![field] !== manifest.funding[field],
      )
    )
      return c.json(
        { error: "Funding outpoint does not match this vault." },
        409,
      );
    if (
      hex.encode(outputScript(manifest.destination)) !== manifest.outputScript
    )
      return c.json({ error: "Destination script mismatch." }, 400);
    if (BigInt(manifest.outputValue) <= 0n || BigInt(manifest.fee) <= 0n)
      return c.json({ error: "Output and fee must be positive." }, 400);
    if (
      BigInt(manifest.funding.value) + BigInt(manifest.helper.value) !==
      BigInt(manifest.outputValue) + BigInt(manifest.fee)
    )
      return c.json({ error: "Transaction amounts do not balance." }, 400);
    await ledger.unspent(manifest.funding, v.scriptHex);
    await ledger.unspent(manifest.helper, hex.encode(outputScript(owner)));
    const now = new Date().toISOString();
    const job: Job = {
      id,
      owner,
      vaultId: manifest.vaultId,
      manifest,
      manifestHash: hash(JSON.stringify(manifest)),
      solver: pinSolver(v),
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
    if (!enabled || !rehearsalAddressAllowed(c.get("owner")))
      return c.json({ error: `${NETWORK_ID} withdrawals are disabled.` }, 503);
    const body = z
      .object({
        rawTxHex: z.string().max(150000),
        spentFixtureRefs: z.array(z.unknown()).max(32).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const { rawTxHex } = body;
    const pk = `OWNER#${c.get("owner")}`,
      sk = `JOB#${c.req.param("id")}`,
      row = await store.get(pk, sk);
    if (!row) return c.json({ error: "Job not found" }, 404);
    const job = row.job as Job;
    if (supervisedServiceJob(job))
      return c.json({ error: "Supervised jobs are not controlled by this route." }, 409);
    const vaultRow = await store.get(pk, `VAULT#${job.vaultId}`);
    if (!vaultRow) return c.json({ error: "Vault not found" }, 404);
    if ((vaultRow.vault as PublicVault).network !== NETWORK_ID)
      return c.json(
        { error: "Vault belongs to a different Bitcoin network." },
        409,
      );
    const amountSats = job.manifest?.outputValue;
    const feeSats = job.manifest?.fee;
    if (typeof amountSats !== "string" || typeof feeSats !== "string")
      throw new MinerInclusionError("ExactSpendMismatch");
    // The requester cannot supply exactSpend, so this route cannot satisfy 7.3.
    const permit = authorizeConfiguredSpend({
      chain: NETWORK_ID,
      chainBaseUrl: chainBase,
      minerEndpoint: minerBase,
      rawTxHex,
      txid: transactionId(rawTxHex),
      amountSats,
      feeSats,
      exactSpend: undefined,
      spentFixtureRefs: body.spentFixtureRefs ?? [],
      release,
      walletApp: "xverse",
    });
    // Same refusal as funding: no chain read, no miner preflight, and no
    // submitted job or transaction intent.
    assertMainnetTransportClosed(permit, minerBase);
    await callMinerSubmit({
      permit,
      rawTxHex,
      transport: { endpoint: minerBase },
    });
    throw new MinerInclusionError("LiveMinerTransportRefused");
  });
  app.post("/api/jobs/:id/pause", async (c) => {
    const pk = `OWNER#${c.get("owner")}`,
      sk = `JOB#${c.req.param("id")}`;
    const r = await store.get(pk, sk);
    if (!r) return c.json({ error: "Job not found" }, 404);
    const job = r.job as Job;
    if (supervisedServiceJob(job))
      return c.json({ error: "Supervised jobs are not controlled by this route." }, 409);
    if (!["searching", "queued"].includes(job.status))
      return c.json({ error: "This job cannot be paused." }, 409);
    if (job.status === "searching" && !job.runpodId)
      job.error =
        "Submission outcome unknown. Reconcile Runpod before resuming.";
    job.status = "paused";
    job.updatedAt = new Date().toISOString();
    await store.put({ ...r, version: r.version + 1, job }, r.version);
    return c.json({ job });
  });
  app.post("/api/jobs/:id/resume", async (c) => {
    if (!enabled || !rehearsalAddressAllowed(c.get("owner")))
      return c.json({ error: `${NETWORK_ID} withdrawals are disabled.` }, 503);
    const pk = `OWNER#${c.get("owner")}`,
      sk = `JOB#${c.req.param("id")}`,
      row = await store.get(pk, sk);
    if (!row) return c.json({ error: "Job not found" }, 404);
    const job = row.job as Job;
    if (supervisedServiceJob(job))
      return c.json({ error: "Supervised jobs are not controlled by this route." }, 409);
    if (job.status !== "paused")
      return c.json({ error: "Only a paused job can be resumed." }, 409);
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
      return c.json(
        { error: "Stopped coverage cannot be resumed on this account." },
        409,
      );
    if (job.error?.includes("Submission outcome unknown"))
      return c.json(
        { error: "Reconcile the unknown Runpod submission before retrying." },
        409,
      );
    if (
      job.error?.includes("range exhausted") ||
      job.error?.includes("failed independent")
    )
      return c.json({ error: "This failure needs operator review." }, 409);
    job.status = "queued";
    job.retryRequested = true;
    job.revision++;
    job.updatedAt = new Date().toISOString();
    delete job.error;
    await store.put({ ...row, job, version: row.version + 1 }, row.version);
    await startWorkflow(job);
    return c.json({ job }, 202);
  });
  app.get("/api/jobs/:id/status", async (c) => {
    const pk = `OWNER#${c.get("owner")}`,
      sk = `JOB#${c.req.param("id")}`,
      row = await store.get(pk, sk);
    if (!row) return c.json({ error: "Job not found" }, 404);
    const job = row.job as Job;
    if (supervisedServiceJob(job))
      return c.json({ error: "Supervised jobs are not controlled by this route." }, 409);
    if (!job.txid) return c.json({ job });
    const status = await ledger.status(job.txid),
      vaultRow = await store.get(pk, `VAULT#${job.vaultId}`);
    if (!vaultRow) return c.json({ error: "Vault not found" }, 404);
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
    return c.json({ job, status });
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
