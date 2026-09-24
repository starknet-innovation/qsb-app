/** CPU-only historical public replay through the enrolled Store route. No GPU or network transport. */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { MemoryStore } from "../../server/store";
import { fingerprint } from "../../src/lib/provenance";
import { PinInventoryV3 } from "../../supervised/runtime/source/work/yukon-indexed-pin-20260923/pin-inventory-v3";
import { SCHEMA } from "../../supervised/runtime/source/work/yukon-indexed-controller-20260923/identity-index";
import {
  receiveResearchPin,
  handoffResearchPin,
  PIN_RESEARCH_RELEASE,
  PIN_RESEARCH_RELEASE_ID,
  PIN_RESEARCH_RELEASE_PK,
} from "./pin_route";

const [bundleFile, outputFile] = process.argv.slice(2);
if (!bundleFile || !outputFile)
  throw Error("Expected explicit public bundle and new receipt path");
// Read only the named public bundle. The subprocess exports parameters; it never runs a solver.
const python = `import sys,json
sys.path.insert(0,'scripts/yukon')
from pin_reference import reference,fingerprint
b=json.load(open(sys.argv[1]));ctx={'publicStateJson':b['request']['vault']['publicStateJson'],'manifest':b['fixture']['manifest']}
pin={k:b['solution'][k] for k in ('sequence','locktime')};lower=pin['locktime']//256*256
req={'protocol':'qsb-yukon-pinning-research-v1','requestId':'cpu-only-historical-route-replay','manifestHash':fingerprint(ctx['manifest']),'binarySha256':sys.argv[2],**reference({**ctx,'stage':'pinning','action':'export'}),'range':{'sequence':pin['sequence'],'sequenceCount':1,'locktime':lower,'locktimeCount':pin['locktime']-lower+1}}
out={k:req[k] for k in ('protocol','requestId','manifestHash','binarySha256','parameterSha256','range')}
out.update(status='range-drained',candidates=[{**pin,'recid':0}],verified=False,rangeCreditEligible=False,releaseStatus='HOLD')
print(json.dumps({'context':ctx,'request':req,'output':out,'pin':pin}))`;
const input = JSON.parse(
  execFileSync(
    "python3",
    ["-I", "-c", python, bundleFile, PIN_RESEARCH_RELEASE.binarySha256],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      timeout: 30000,
    },
  ),
);
const results = [];
for (const scenario of [
  "positive",
  "revoke-at-drain",
  "unknown-sibling",
] as const) {
  const store = new MemoryStore();
  const binding = {
    scope: "isolated-yukon-positive-" + scenario,
    owner: "cpu-replay",
    revision: 1,
    intent: "PIN#0",
  };
  const pk = "VALIDATION#" + binding.scope;
  const release = {
    pk: PIN_RESEARCH_RELEASE_PK,
    sk: PIN_RESEARCH_RELEASE_ID,
    version: 0,
    enabled: true,
    descriptor: PIN_RESEARCH_RELEASE,
    endpoint: "synthetic-endpoint",
    scopes: [binding.scope],
  };
  await store.put(release);
  await store.put({
    pk,
    sk: "SCOPE",
    version: 1,
    owner: binding.owner,
    revision: 1,
    identitySchema: SCHEMA,
    endpoint: release.endpoint,
    researchReleaseId: PIN_RESEARCH_RELEASE_ID,
    stage: "pinning",
    phase: "pinning_searching",
    publicContext: JSON.stringify(input.context),
    publicContextHash: fingerprint(input.context),
    budget: {
      maxConcurrent: 1,
      maxSubmissions: 1,
      claimed: 0,
      deadlineMs: Date.now() + 60000,
    },
  });
  const inventory = new PinInventoryV3(store, binding.scope, binding.owner, 1);
  await inventory.reserve(0, input.request, async () => {});
  // This callback returns an inert ID locally; no live provider API exists in this script.
  await inventory.submit(
    "PIN#0",
    async () => "synthetic-positive-provider",
    async () => {},
  );
  const row = (await store.get(pk, "PIN#0"))!;
  await store.put(
    {
      ...row,
      version: row.version + 1,
      researchReleaseId: PIN_RESEARCH_RELEASE_ID,
    },
    row.version,
  );
  const provider = {
    id: "synthetic-positive-provider",
    status: "COMPLETED",
    output: {
      protocol: "qsb-yukon-pin-queue-v1",
      providerJobId: "synthetic-positive-provider",
      runtimeManifestSha256: PIN_RESEARCH_RELEASE.runtimeManifestSha256,
      inputSha256: fingerprint({
        runtimeManifestSha256: PIN_RESEARCH_RELEASE.runtimeManifestSha256,
        request: input.request,
      }),
      output: input.output,
    },
  };
  const verified = await receiveResearchPin(store, binding, provider);
  assert.equal(verified.reference.decision, "candidate-verified");
  assert.equal(verified.rangeCreditEligible, false);
  assert.equal((await store.get(pk, "SCOPE"))?.phase, "pinning_draining");
  if (scenario === "unknown-sibling") {
    const s = (await store.get(pk, "SCOPE"))!;
    await store.atomicPut([
      { row: { ...s, version: s.version + 1 }, expected: s.version },
      {
        row: {
          pk,
          sk: "PIN#1",
          version: 1,
          owner: binding.owner,
          revision: 1,
          state: "uncertain",
          frozen: JSON.stringify(input.request),
        },
      },
    ]);
  }
  let drainReads = 0;
  const observe = async () => {
    drainReads++;
    if (scenario === "revoke-at-drain")
      await store.put({ ...release, version: 1, enabled: false }, 0);
    return {
      endpoint: release.endpoint,
      workersMin: 0,
      workersMax: 0,
      queued: 0,
      inProgress: 0,
      observedAtMs: Date.now(),
    };
  };
  if (scenario === "positive") {
    const handoff = await handoffResearchPin(store, binding, observe);
    assert.deepEqual(handoff.pin, input.pin);
    assert.equal(handoff.dispatchAuthorized, false);
    assert.equal(handoff.consensusVerified, false);
    assert.equal(
      (await store.get(pk, "SCOPE"))?.phase,
      "research_subset_prepared",
    );
    assert.equal((await store.get(pk, "SCOPE"))?.completedRanges, undefined);
    await assert.rejects(handoffResearchPin(store, binding, observe));
    results.push({
      scenario,
      contextHash: handoff.contextHash,
      parameters: Object.fromEntries(
        Object.entries(handoff.parameters).map(([k, v]) => [
          k,
          v.parameterSha256,
        ]),
      ),
      duplicateHandoffRejected: true,
      dispatchAuthorized: false,
    });
  } else {
    const before = fingerprint(await store.get(pk, "PIN#0"));
    await assert.rejects(handoffResearchPin(store, binding, observe));
    assert.equal((await store.get(pk, "SCOPE"))?.phase, "pinning_draining");
    assert.equal(fingerprint(await store.get(pk, "PIN#0")), before);
    assert.equal(drainReads, scenario === "unknown-sibling" ? 0 : 1);
    results.push({
      scenario,
      handoffRejected: true,
      winnerUnchanged: true,
      drainReads,
    });
  }
}
writeFileSync(
  outputFile,
  JSON.stringify(
    {
      scope:
        "Actual CPU known-solution replay through release-enrolled publication and handoff; MemoryStore; synthetic provider envelope and drain observations",
      results,
      gpuExecuted: false,
      paidProviderCalls: 0,
      rangeSearched: false,
      fixtureSpentThisRun: false,
      positiveGpuHitEstablished: false,
      freshWithdrawal: false,
      releaseStatus: "HOLD",
      releaseId: PIN_RESEARCH_RELEASE_ID,
      sourceSha256: Object.fromEntries(
        [
          "scripts/yukon/pin_route.ts",
          "scripts/yukon/pin_store.ts",
          "scripts/yukon/pin_verifier.ts",
          "scripts/yukon/pin_verifier_lock.json",
        ].map((file) => [
          file,
          createHash("sha256").update(readFileSync(file)).digest("hex"),
        ]),
      ),
      scriptSha256: createHash("sha256")
        .update(readFileSync("scripts/yukon/check_pin_positive_route.ts"))
        .digest("hex"),
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
