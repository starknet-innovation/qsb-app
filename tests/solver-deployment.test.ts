import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { SFNClient } from "@aws-sdk/client-sfn";
vi.mock("../src/lib/releases/registry.generated", async () => {
  const { servedFixture, otherFixture } = await import("./solver-fixture");
  const old = (await import("../src/lib/releases/qsb-solver-v0-1-0.json")).default;
  return {default:[servedFixture,otherFixture,old]};
});
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { fixtureVault, servedFixture } from "./solver-fixture";
import archived from "../src/lib/releases/qsb-config-a-ranked-v2.json";
import old from "../src/lib/releases/qsb-solver-v0-1-0.json";
import { deployedSolver } from "../server/solver-deployment";
afterEach(() => {vi.unstubAllEnvs();vi.restoreAllMocks();});
async function fixture() {
  const store = new MemoryStore();
  const publicKey = hex.decode("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
  const payment = btc.p2wpkh(publicKey), owner = payment.address!;
  const token = "a".repeat(43);
  const funding = {txid:"11".repeat(32),vout:0,value:"1000"};
  const vault = {...fixtureVault,id:crypto.randomUUID(),status:"confirmed",funding};
  await store.put({pk:`OWNER#${owner}`,sk:`VAULT#${vault.id}`,version:0,vault});
  await store.put({pk:`SESSION#${createHash("sha256").update(token).digest("hex")}`,sk:"AUTH",version:0,owner,network:"mainnet"});
  const unspent = vi.fn().mockResolvedValue({});
  const app = createApp(store,{enabled:true,chain:{unspent} as any});
  vi.stubEnv("WORKFLOW_ARN","arn:aws:states:eu-west-1:123456789012:stateMachine:test");
  const workflow = vi.spyOn(SFNClient.prototype,"send").mockResolvedValue({} as never);
  const manifest = {vaultId:vault.id,funding,helper:{txid:"22".repeat(32),vout:0,value:"500"},destination:owner,outputScript:hex.encode(payment.script),outputValue:"1200",fee:"300",idempotencyKey:crypto.randomUUID(),costAccepted:true};
  const post = (body: unknown) => app.request("/api/jobs",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
  return {store,app,manifest,post,workflow,unspent};
}
it.each([
  [undefined,undefined],
  ["unknown",undefined],
  [archived.id,undefined],
  [old.id,undefined],
  [servedFixture.id,archived.id],
  [servedFixture.id,old.id],
  [servedFixture.id,"external-test"],
])("rejects served %s/requested %s without writes or workflow",async (served, requested) => {
  vi.stubEnv("SOLVER_RELEASE_ID",served);
  const f = await fixture();
  const before = structuredClone([...f.store.rows]);
  const response = await f.post({...f.manifest,...(requested ? {solverReleaseId:requested}: {})});
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({error:expect.stringContaining("No withdrawal was reserved")});
  expect([...f.store.rows]).toEqual(before);
  expect(f.unspent).not.toHaveBeenCalled();
  expect(f.workflow).not.toHaveBeenCalled();
});
it.each([false,true])("pins the served release before reserving funds (explicit=%s)",async explicit => {
  vi.stubEnv("SOLVER_RELEASE_ID",servedFixture.id);
  const f = await fixture();
  const response = await f.post({...f.manifest,...(explicit ? {solverReleaseId:servedFixture.id}: {})});
  expect(response.status).toBe(201);
  expect((await response.json()).job.solver.descriptor).toEqual(servedFixture);
  expect([...f.store.rows.values()].filter(row=>row.pk.startsWith("OUTPOINT#"))).toHaveLength(2);
  expect(f.workflow).toHaveBeenCalledTimes(1);
  expect((await (await f.app.request("/api/config")).json()).solverReleaseId).toBe(servedFixture.id);
});
it("does not advertise absent or legacy deployment configuration",async () => {
  const f = await fixture();
  for (const id of [undefined,old.id,archived.id,"unknown"]) {
    vi.stubEnv("SOLVER_RELEASE_ID",id);
    expect(() => deployedSolver()).toThrow();
    expect((await (await f.app.request("/api/config")).json()).solverReleaseId).toBeNull();
  }
});

it.each([undefined,old.id,"external-test"])("idempotent queued replay is read-only after served release changes to %s",async id => {
  vi.stubEnv("SOLVER_RELEASE_ID",servedFixture.id);
  const f = await fixture();
  expect((await f.post(f.manifest)).status).toBe(201);
  f.workflow.mockClear();
  const before = structuredClone([...f.store.rows]);
  vi.stubEnv("SOLVER_RELEASE_ID",id);
  expect((await f.post(f.manifest)).status).toBe(200);
  expect(f.workflow).not.toHaveBeenCalled();
  expect([...f.store.rows]).toEqual(before);
});
