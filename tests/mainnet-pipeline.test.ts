import { readFileSync } from "node:fs";
import { SFNClient } from "@aws-sdk/client-sfn";
import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { afterEach, expect, it, vi } from "vitest";
import { deployedApiApp } from "../server/lambda";
import { MemoryStore } from "../server/store";
import capability from "../server/mainnet-capability.json";
import { release } from "../src/lib/model";
import { NETWORK_ID } from "../src/lib/network";

const privateKey = new Uint8Array(32).fill(1);
const address = btc.p2wpkh(secp256k1.getPublicKey(privateKey)).address!;

function request(path: string, body: unknown, token?: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function signIn(app: ReturnType<typeof deployedApiApp>) {
  const challenge = await (
    await app.request(request("/api/auth/challenge", { address }))
  ).json();
  const signature = Signer.sign(
    btc.WIF().encode(privateKey),
    address,
    challenge.message,
  );
  const login = await app.request(
    request("/api/auth/verify", { id: challenge.id, signature }),
  );
  expect(login.status).toBe(200);
  return (await login.json()).token as string;
}

function withdrawalBody() {
  return {
    vaultId: crypto.randomUUID(),
    funding: { txid: "11".repeat(32), vout: 0, value: "1000" },
    helper: { txid: "22".repeat(32), vout: 1, value: "500" },
    destination: address,
    outputScript: "0014" + "ab".repeat(20),
    outputValue: "1000",
    fee: "500",
    idempotencyKey: crypto.randomUUID(),
    costAccepted: true as const,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("documents one mainnet pipeline through createApp, startWorkflow, and the coordinator", () => {
  const lambda = readFileSync("server/lambda.ts", "utf8");
  const app = readFileSync("server/app.ts", "utf8");
  const workflow = readFileSync("terraform/workflow.tf", "utf8");
  const releaseGate = readFileSync("terraform/data.tf", "utf8");
  expect(lambda).toContain('network === "mainnet"');
  expect(lambda).toContain("return createApp(records)");
  expect(lambda).not.toContain("installSupervisedCreation(");
  expect(app).toContain("await startWorkflow(job)");
  expect(workflow).toContain("function:${var.name}-coordinator");
  expect(releaseGate).toContain('toset(["api", "coordinator", "reference"])');
  expect(releaseGate).not.toContain("provision_runtime");
  expect(release.mainnetEnabled).toBe(false);
  expect(capability.broadcastAuthorized).toBe(false);
});

it("does not mount supervised job creation on the mainnet lambda", async () => {
  const store = new MemoryStore();
  const app = deployedApiApp("mainnet", store);
  const token = await signIn(app);
  const response = await app.request(
    request("/api/jobs/supervised", {}, token),
  );
  expect(response.status).toBe(404);
  const config = await (await app.request("/api/config")).json();
  expect(config.mainnetEnabled).toBe(false);
  expect(config.operationsEnabled).toBe(false);
  expect(config.supervisedSearch.enabled).toBe(false);
  expect(config.network).toBe(NETWORK_ID);
});

it("keeps supervised creation off the mainnet lambda and available only on the other constructor", async () => {
  const store = new MemoryStore();
  const app = deployedApiApp("testnet4", store);
  const token = await signIn(app);
  const response = await app.request(
    request("/api/jobs/supervised", {}, token),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "Supervised job creation is disabled.",
  });
});

it("refuses mainnet funding, job creation, resume, and submit while the flags are false", async () => {
  vi.stubEnv(
    "WORKFLOW_ARN",
    "arn:aws:states:eu-west-1:123456789012:stateMachine:qsb-withdrawal",
  );
  const send = vi.spyOn(SFNClient.prototype, "send").mockImplementation(() => {
    throw new Error("workflow must not start");
  });
  const store = new MemoryStore();
  const app = deployedApiApp("mainnet", store);
  const token = await signIn(app);
  const created = await app.request(
    request("/api/jobs", withdrawalBody(), token),
  );
  const funded = await app.request(
    request("/api/vaults/00000000-0000-4000-8000-000000000001/fund", {}, token),
  );
  const resumed = await app.request(
    request("/api/jobs/00000000-0000-4000-8000-000000000001/resume", {}, token),
  );
  const submitted = await app.request(
    request("/api/jobs/00000000-0000-4000-8000-000000000001/submit", {}, token),
  );
  expect(created.status).toBe(503);
  expect(funded.status).toBe(503);
  expect(resumed.status).toBe(503);
  expect(submitted.status).toBe(503);
  expect((await created.json()).error).toBe(
    `${NETWORK_ID} withdrawals are disabled pending validation and operator configuration.`,
  );
  expect((await funded.json()).error).toBe(
    `${NETWORK_ID} funding is disabled pending validation and operator configuration.`,
  );
  expect((await resumed.json()).error).toBe(
    `${NETWORK_ID} withdrawals are disabled.`,
  );
  expect((await submitted.json()).error).toBe(
    `${NETWORK_ID} withdrawals are disabled.`,
  );
  expect([...store.rows.keys()].some((key) => key.includes("JOB#"))).toBe(
    false,
  );
  expect(send).not.toHaveBeenCalled();
});
