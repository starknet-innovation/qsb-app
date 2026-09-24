import { recordResearchPinTerminal } from "../scripts/yukon/pin_terminal";
import * as pinVerifier from "../scripts/yukon/pin_verifier";
import { reconcileResearchPin } from "../scripts/yukon/pin_reconcile";
import { submitResearchPin } from "../scripts/yukon/pin_submit";
import { readFileSync } from "node:fs";
import {
  receiveResearchPin,
  handoffResearchPin,
  PIN_RESEARCH_RELEASE,
  PIN_RESEARCH_RELEASE_ID,
  PIN_RESEARCH_RELEASE_PK,
} from "../scripts/yukon/pin_route";
import { execFileSync } from "node:child_process";
import { createPinVerifier } from "../scripts/yukon/pin_verifier";
import { createHash, randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} from "@aws-sdk/client-dynamodb";
import { describe, it, expect, afterAll, vi } from "vitest";
import { MemoryStore, DynamoStore } from "../server/store";
import { fingerprint } from "../src/lib/provenance";
import { PinInventoryV3 } from "../supervised/runtime/source/work/yukon-indexed-pin-20260923/pin-inventory-v3";
import { SCHEMA } from "../supervised/runtime/source/work/yukon-indexed-controller-20260923/identity-index";
import {
  publishResearchPin,
  prepareResearchSubset,
} from "../scripts/yukon/pin_store";

// Explicit opt-in is restricted to a dummy-credential loopback service.
const localEndpoint = process.env.QSB_PIN_TEST_DYNAMODB;
const tables: string[] = [];
function localClient() {
  if (
    !localEndpoint ||
    !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(localEndpoint) ||
    process.env.AWS_ENDPOINT_URL_DYNAMODB !== localEndpoint ||
    process.env.AWS_ACCESS_KEY_ID !== "qsbLocalDummy" ||
    process.env.AWS_SECRET_ACCESS_KEY !== "qsbLocalDummy" ||
    process.env.AWS_SESSION_TOKEN ||
    process.env.AWS_REGION !== "us-east-1"
  )
    throw Error("Dummy-credential loopback DynamoDB required");
  return new DynamoDBClient({
    endpoint: localEndpoint,
    region: "us-east-1",
    credentials: {
      accessKeyId: "qsbLocalDummy",
      secretAccessKey: "qsbLocalDummy",
    },
  });
}
afterAll(async () => {
  if (!tables.length) return;
  const client = localClient();
  try {
    for (const TableName of tables)
      await client.send(new DeleteTableCommand({ TableName }));
  } finally {
    client.destroy();
  }
});
async function testStore() {
  if (!localEndpoint) return new MemoryStore();
  const client = localClient(),
    table = "qsb-pin-" + randomUUID();
  try {
    await client.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
      }),
    );
    tables.push(table);
  } finally {
    client.destroy();
  }
  return new DynamoStore(table);
}

async function fixture(
  real?: {
    context: any;
    request: any;
    output: any;
    providerId?: string;
  },
  unsubmitted = false,
) {
  const store = await testStore(),
    scope = "isolated-yukon-pr30-store",
    pk = "VALIDATION#" + scope;
  const binding = {
    scope,
    owner: "test-owner",
    revision: 1,
    intent: "PIN#0",
    binarySha256: real?.request.binarySha256 ?? "a".repeat(64),
  };
  const context = real?.context ?? {
    publicStateJson: "synthetic-test-context",
    manifest: { synthetic: true },
  };
  const request = real?.request ?? {
    protocol: "qsb-yukon-pinning-research-v1",
    requestId: "test",
    manifestHash: fingerprint(context.manifest),
    binarySha256: binding.binarySha256,
    parameterSha256: "b".repeat(64),
    parameterBase64: "test",
    range: {
      sequence: 2147483648,
      sequenceCount: 1,
      locktime: 500000000,
      locktimeCount: 1,
    },
  };
  await store.put({
    pk,
    sk: "SCOPE",
    version: 1,
    owner: binding.owner,
    revision: 1,
    identitySchema: SCHEMA,
    endpoint: "synthetic-endpoint",
    stage: "pinning",
    phase: "pinning_searching",
    publicContext: JSON.stringify(context),
    publicContextHash: fingerprint(context),
    budget: {
      maxConcurrent: 1,
      maxSubmissions: 1,
      claimed: 0,
      deadlineMs: Date.now() + 60000,
    },
  });
  const inventory = new PinInventoryV3(store, scope, binding.owner, 1);
  if (!unsubmitted) {
    await inventory.reserve(0, request, async () => {});
    await inventory.submit(
      "PIN#0",
      async () => real?.providerId ?? "synthetic-provider",
      async () => {},
    );
  }
  const { parameterBase64: _, ...fields } = request;
  const output = real?.output ?? {
    ...fields,
    status: "range-drained",
    candidates: [{ sequence: 2147483648, locktime: 500000000, recid: 0 }],
    verified: false,
    rangeCreditEligible: false,
    releaseStatus: "HOLD",
  };
  const provider = {
    id: real?.providerId ?? "synthetic-provider",
    status: "COMPLETED",
    output,
  };
  const verdict = {
    referenceChecked: true,
    contextHash: fingerprint(context),
    verdicts: [{ valid: true, sequence: 2147483648, locktime: 500000000 }],
    decision: "candidate-verified",
    rangeCreditEligible: false,
    releaseStatus: "HOLD",
    freshWithdrawal: false,
  };
  return { store, pk, binding, provider, verdict };
}

describe("research pin publication through real Store and indexed submission", () => {
  it("publishes a candidate once and requests drain without range credit", async () => {
    const f = await fixture();
    await publishResearchPin(
      f.store,
      f.binding,
      f.provider,
      async () => f.verdict,
    );
    const scope = await f.store.get(f.pk, "SCOPE"),
      row = await f.store.get(f.pk, "PIN#0");
    expect(scope?.phase).toBe("pinning_draining");
    expect(scope?.completedRanges).toBeUndefined();
    expect(row?.state).toBe("research_result_verified");
    await expect(
      publishResearchPin(f.store, f.binding, f.provider, async () => f.verdict),
    ).rejects.toThrow();
  });
  it("allows only one racing publication", async () => {
    const f = await fixture();
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const verify = async () => {
      if (++entered === 2) release();
      await gate;
      return f.verdict;
    };
    const results = await Promise.allSettled([
      publishResearchPin(f.store, f.binding, f.provider, verify),
      publishResearchPin(f.store, f.binding, f.provider, verify),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });
  it("rejects pause or provider identity changes during CPU verification atomically", async () => {
    for (const kind of ["pause", "identity"]) {
      const f = await fixture();
      const before = await f.store.get(f.pk, "PIN#0");
      await expect(
        publishResearchPin(f.store, f.binding, f.provider, async () => {
          const key = kind === "pause" ? "SCOPE" : "IDENTITY#PIN#0";
          const row = (await f.store.get(f.pk, key))!;
          await f.store.put(
            {
              ...row,
              version: row.version + 1,
              ...(kind === "pause"
                ? { phase: "paused", revision: 2 }
                : { ambiguous: true }),
            },
            row.version,
          );
          return f.verdict;
        }),
      ).rejects.toThrow();
      expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
    }
  });
  it("rejects mismatched provider, range and CPU context without writes", async () => {
    for (const kind of ["provider", "range", "cpu"]) {
      const f = await fixture();
      const before = await f.store.get(f.pk, "PIN#0");
      if (kind === "provider") f.provider.id = "other";
      if (kind === "range") f.provider.output.range.locktimeCount = 2;
      if (kind === "cpu") f.verdict.contextHash = "c".repeat(64);
      await expect(
        publishResearchPin(
          f.store,
          f.binding,
          f.provider,
          async () => f.verdict,
        ),
      ).rejects.toThrow();
      expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
    }
  });
  it("records empty drained results without granting coverage", async () => {
    const f = await fixture();
    f.provider.output.candidates = [];
    f.verdict.verdicts = [];
    f.verdict.decision = "range-drained-reference-bound";
    const receipt = await publishResearchPin(
      f.store,
      f.binding,
      f.provider,
      async () => f.verdict,
    );
    expect(receipt.rangeCreditEligible).toBe(false);
    const s = await f.store.get(f.pk, "SCOPE");
    expect(s?.phase).toBe("pinning_searching");
    expect(s?.completedRanges).toBeUndefined();
  });
  it("preserves attached work when verification fails or ownership is stale", async () => {
    for (const kind of ["throw", "owner", "revision", "decision"]) {
      const f = await fixture();
      const before = await f.store.get(f.pk, "PIN#0");
      if (kind === "owner") f.binding.owner = "other";
      if (kind === "revision") f.binding.revision = 2;
      if (kind === "decision")
        f.verdict.decision = "range-drained-reference-bound";
      await expect(
        publishResearchPin(f.store, f.binding, f.provider, async () => {
          if (kind === "throw") throw Error("CPU failed");
          return f.verdict;
        }),
      ).rejects.toThrow();
      expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
    }
  });
  it("rejects a global provider claim changed during verification", async () => {
    const f = await fixture();
    const before = await f.store.get(f.pk, "PIN#0");
    await expect(
      publishResearchPin(f.store, f.binding, f.provider, async () => {
        const rows = await f.store.list(
          "VALIDATION#YUKON_PROVIDER_IDS",
          createHash("sha256").update(f.provider.id).digest("hex"),
        );
        const claim = rows[0];
        await f.store.put(
          { ...claim, version: claim.version + 1, scope: "other" },
          claim.version,
        );
        return f.verdict;
      }),
    ).rejects.toThrow();
    expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
  });
});

function realPublicCase() {
  const script =
    "import sys,json;sys.path.insert(0,'scripts/yukon');from test_pin_reference import ReferenceBinding as R;R.setUpClass();print(json.dumps({'context':R.ctx,'request':R.req,'output':R.out}))";
  return JSON.parse(
    execFileSync("python3", ["-I", "-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      timeout: 10000,
    }),
  );
}

describe("real CPU process composed with Store publication", () => {
  it("binds a real public export and records an empty result without credit", async () => {
    const f = await fixture(realPublicCase());
    const receipt = await publishResearchPin(
      f.store,
      f.binding,
      f.provider,
      createPinVerifier(),
    );
    expect(receipt.reference.referenceChecked).toBe(true);
    expect(receipt.rangeCreditEligible).toBe(false);
    expect((await f.store.get(f.pk, "PIN#0"))?.state).toBe(
      "research_result_verified",
    );
  });
  it("rejects a false candidate from actual full-transaction CPU verification", async () => {
    const c = realPublicCase();
    c.output.candidates = [
      { sequence: 2147483648, locktime: 500000000, recid: 0 },
    ];
    const f = await fixture(c),
      before = await f.store.get(f.pk, "PIN#0");
    await expect(
      publishResearchPin(f.store, f.binding, f.provider, createPinVerifier()),
    ).rejects.toThrow("CPU verifier rejected");
    expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
  });
  it("retains pause fencing around a successful real CPU process", async () => {
    const f = await fixture(realPublicCase()),
      cpu = createPinVerifier(),
      before = await f.store.get(f.pk, "PIN#0");
    await expect(
      publishResearchPin(f.store, f.binding, f.provider, async (...args) => {
        const result = await cpu(...args);
        const scope = (await f.store.get(f.pk, "SCOPE"))!;
        await f.store.put(
          {
            ...scope,
            version: scope.version + 1,
            phase: "paused",
            revision: 2,
          },
          scope.version,
        );
        return result;
      }),
    ).rejects.toThrow();
    expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
  });
});

async function drainingFixture() {
  const f = await fixture();
  await publishResearchPin(
    f.store,
    f.binding,
    f.provider,
    async () => f.verdict,
  );
  const parameter = {
    parameterBase64: "cHVibGlj",
    parameterSha256: createHash("sha256").update("public").digest("hex"),
  };
  const handoff = {
    format: "qsb-research-pin-handoff-v1",
    contextHash: f.verdict.contextHash,
    pin: { sequence: 2147483648, locktime: 500000000 },
    parameters: { round1: parameter, round2: parameter },
    referenceChecked: true,
    dispatchAuthorized: false,
    consensusVerified: false,
    releaseStatus: "HOLD",
  };
  const observe = async () => ({
    endpoint: "synthetic-endpoint",
    workersMin: 0,
    workersMax: 0,
    queued: 0,
    inProgress: 0,
    observedAtMs: Date.now(),
  });
  return { ...f, handoff, observe };
}
describe("research pin drain and subset preparation", () => {
  it("prepares both round parameters only once and never authorizes dispatch", async () => {
    const f = await drainingFixture();
    const receipt = await prepareResearchSubset(
      f.store,
      f.binding,
      async () => f.handoff,
      f.observe,
    );
    expect(receipt.dispatchAuthorized).toBe(false);
    expect((await f.store.get(f.pk, "SCOPE"))?.phase).toBe(
      "research_subset_prepared",
    );
    await expect(
      prepareResearchSubset(
        f.store,
        f.binding,
        async () => f.handoff,
        f.observe,
      ),
    ).rejects.toThrow();
  });
  it("refuses reserved or uncertain sibling work", async () => {
    for (const state of ["reserved", "uncertain"]) {
      const f = await drainingFixture(),
        s = (await f.store.get(f.pk, "SCOPE"))!,
        winner = (await f.store.get(f.pk, "PIN#0"))!;
      await f.store.atomicPut([
        { row: { ...s, version: s.version + 1 }, expected: s.version },
        {
          row: {
            pk: f.pk,
            sk: "PIN#1",
            version: 1,
            owner: f.binding.owner,
            revision: 1,
            state,
            frozen: winner.frozen,
          },
        },
      ]);
      await expect(
        prepareResearchSubset(
          f.store,
          f.binding,
          async () => f.handoff,
          f.observe,
        ),
      ).rejects.toThrow("Unresolved sibling");
      expect((await f.store.get(f.pk, "SCOPE"))?.phase).toBe(
        "pinning_draining",
      );
    }
  });
  it("rejects busy, stale or wrong endpoint observations without advancing", async () => {
    for (const changed of [
      { queued: 1 },
      { workersMax: 1 },
      { endpoint: "other" },
      { observedAtMs: Date.now() - 60000 },
    ]) {
      const f = await drainingFixture();
      await expect(
        prepareResearchSubset(
          f.store,
          f.binding,
          async () => f.handoff,
          async () => ({ ...(await f.observe()), ...changed }),
        ),
      ).rejects.toThrow();
      expect((await f.store.get(f.pk, "SCOPE"))?.phase).toBe(
        "pinning_draining",
      );
    }
  });
  it("rejects a pause during handoff and a corrupted parameter digest", async () => {
    for (const mode of ["pause", "digest"]) {
      const f = await drainingFixture();
      await expect(
        prepareResearchSubset(
          f.store,
          f.binding,
          async () => {
            if (mode === "pause") {
              const s = (await f.store.get(f.pk, "SCOPE"))!;
              await f.store.put(
                { ...s, version: s.version + 1, phase: "paused", revision: 2 },
                s.version,
              );
            } else f.handoff.parameters.round1.parameterSha256 = "d".repeat(64);
            return f.handoff;
          },
          f.observe,
        ),
      ).rejects.toThrow();
      expect((await f.store.get(f.pk, "PIN#0"))?.state).toBe(
        "research_result_verified",
      );
    }
  });
});

async function enrolledRemoteReplay() {
  const base = "research/yukon-intake/20260924/runtime/remote-queue/";
  const read = (name: string) => JSON.parse(readFileSync(base + name, "utf8"));
  const raw = read("result-0.json"),
    input = read("input-0.json");
  const f = await fixture({
    context: read("context-0.json"),
    request: input.request,
    output: raw.output.output,
    providerId: raw.id,
  });
  for (const sk of ["SCOPE", "PIN#0"]) {
    const row = (await f.store.get(f.pk, sk))!;
    await f.store.put(
      {
        ...row,
        version: row.version + 1,
        researchReleaseId: PIN_RESEARCH_RELEASE_ID,
      },
      row.version,
    );
  }
  const enrollment = {
    pk: PIN_RESEARCH_RELEASE_PK,
    sk: PIN_RESEARCH_RELEASE_ID,
    version: 0,
    enabled: true,
    descriptor: PIN_RESEARCH_RELEASE,
    endpoint: "synthetic-endpoint",
    scopes: [f.binding.scope],
  };
  await f.store.put(enrollment);
  return { ...f, raw, enrollment };
}

describe("explicit release receive route with saved actual remote output and real CPU", () => {
  it("publishes once only under exact research enrollment, without selecting a default or granting credit", async () => {
    const f = await enrolledRemoteReplay();
    const result = await receiveResearchPin(f.store, f.binding, f.raw);
    expect(result.reference.referenceChecked).toBe(true);
    expect(result.rangeCreditEligible).toBe(false);
    expect((await f.store.get(f.pk, "PIN#0"))?.state).toBe(
      "research_result_verified",
    );
    expect((await f.store.get(f.pk, "SCOPE"))?.completedRanges).toBeUndefined();
    await expect(
      receiveResearchPin(f.store, f.binding, f.raw),
    ).rejects.toThrow();
  });
  it("rejects disabled, mismatched image, wrong endpoint or scope, and expired enrollment", async () => {
    for (const patch of [
      { enabled: false },
      {
        descriptor: {
          ...PIN_RESEARCH_RELEASE,
          imageManifestSha256: "f".repeat(64),
        },
      },
      { endpoint: "other" },
      { scopes: [] },
      { expiresAt: 9999999999 },
    ]) {
      const f = await enrolledRemoteReplay(),
        before = await f.store.get(f.pk, "PIN#0");
      await f.store.put({ ...f.enrollment, ...patch, version: 1 }, 0);
      await expect(
        receiveResearchPin(f.store, f.binding, f.raw),
      ).rejects.toThrow("release");
      expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
    }
  });
  it("atomically rejects revocation after CPU verification, preserving the attached result", async () => {
    const f = await enrolledRemoteReplay(),
      before = await f.store.get(f.pk, "PIN#0");
    const atomic = f.store.atomicPut.bind(f.store);
    f.store.atomicPut = async (writes) => {
      await f.store.put({ ...f.enrollment, enabled: false, version: 1 }, 0);
      return atomic(writes);
    };
    await expect(
      receiveResearchPin(f.store, f.binding, f.raw),
    ).rejects.toThrow();
    expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
  });
  it("atomically rejects scope routing replacement during verification", async () => {
    const f = await enrolledRemoteReplay(),
      before = await f.store.get(f.pk, "PIN#0");
    const atomic = f.store.atomicPut.bind(f.store);
    f.store.atomicPut = async (writes) => {
      const row = (await f.store.get(f.pk, "SCOPE"))!;
      await f.store.put(
        { ...row, researchReleaseId: "other", version: row.version + 1 },
        row.version,
      );
      return atomic(writes);
    };
    await expect(
      receiveResearchPin(f.store, f.binding, f.raw),
    ).rejects.toThrow();
    expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
  });
});

async function submissionFixture() {
  const base = "research/yukon-intake/20260924/runtime/remote-queue/";
  const read = (n: string) => JSON.parse(readFileSync(base + n, "utf8"));
  const request = read("input-0.json").request;
  const f = await fixture(
    {
      request,
      context: read("context-0.json"),
      output: read("result-0.json").output.output,
    },
    true,
  );
  const s = (await f.store.get(f.pk, "SCOPE"))!;
  await f.store.put(
    {
      ...s,
      version: s.version + 1,
      researchReleaseId: PIN_RESEARCH_RELEASE_ID,
    },
    s.version,
  );
  const enrollment = {
    pk: PIN_RESEARCH_RELEASE_PK,
    sk: PIN_RESEARCH_RELEASE_ID,
    version: 0,
    enabled: true,
    researchExecutionEnabled: true,
    startupCapacityValidated: true,
    descriptor: PIN_RESEARCH_RELEASE,
    endpoint: "synthetic-endpoint",
    scopes: [f.binding.scope],
  };
  await f.store.put(enrollment);
  return {
    ...f,
    request,
    enrollment,
    submitBinding: {
      scope: f.binding.scope,
      owner: f.binding.owner,
      revision: 1,
      attempt: 0,
    },
  };
}
describe("release-fenced submission with real CPU preflight and mocked paid transport", () => {
  it("allows one racing submission and freezes the exact queue envelope", async () => {
    const f = await submissionFixture();
    let sends = 0;
    const adapters = {
      preflight: async () => {},
      send: async (endpoint: string, input: unknown) => {
        sends++;
        expect(endpoint).toBe("synthetic-endpoint");
        expect(input).toEqual({
          runtimeManifestSha256: PIN_RESEARCH_RELEASE.runtimeManifestSha256,
          request: f.request,
        });
        return "new-research-job";
      },
    };
    const results = await Promise.allSettled([
      submitResearchPin(f.store, f.submitBinding, f.request, adapters),
      submitResearchPin(f.store, f.submitBinding, f.request, adapters),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sends).toBe(1);
    expect((await f.store.get(f.pk, "PIN#0"))?.provider).toBe(
      "new-research-job",
    );
  });
  it("rejects release revocation in provider preflight before the paid call", async () => {
    const f = await submissionFixture();
    let sends = 0;
    await expect(
      submitResearchPin(f.store, f.submitBinding, f.request, {
        preflight: async () => {
          await f.store.put({ ...f.enrollment, version: 1, enabled: false }, 0);
        },
        send: async () => {
          sends++;
          return "must-not-submit";
        },
      }),
    ).rejects.toThrow();
    expect(sends).toBe(0);
    expect((await f.store.get(f.pk, "PIN#0"))?.state).toBe("uncertain");
  });
  it("retains uncertainty and never repeats a transport call after an unknown outcome", async () => {
    const f = await submissionFixture();
    let sends = 0;
    const adapters = {
      preflight: async () => {},
      send: async () => {
        sends++;
        throw Error("connection lost after POST");
      },
    };
    await expect(
      submitResearchPin(f.store, f.submitBinding, f.request, adapters),
    ).rejects.toThrow();
    await expect(
      submitResearchPin(f.store, f.submitBinding, f.request, adapters),
    ).rejects.toThrow();
    expect(sends).toBe(1);
    expect((await f.store.get(f.pk, "PIN#0"))?.state).toBe("uncertain");
  });
  it("preserves a returned provider ID after release revocation during the paid call", async () => {
    const f = await submissionFixture();
    await submitResearchPin(f.store, f.submitBinding, f.request, {
      preflight: async () => {},
      send: async () => {
        await f.store.put({ ...f.enrollment, version: 1, enabled: false }, 0);
        return "late-research-job";
      },
    });
    expect((await f.store.get(f.pk, "PIN#0"))?.provider).toBe(
      "late-research-job",
    );
  });
  it("rejects invalid public parameters before reservation or provider access", async () => {
    const f = await submissionFixture();
    let calls = 0;
    await expect(
      submitResearchPin(
        f.store,
        f.submitBinding,
        { ...f.request, parameterSha256: "f".repeat(64) },
        {
          preflight: async () => {
            calls++;
          },
          send: async () => {
            calls++;
            return "bad";
          },
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    expect(await f.store.get(f.pk, "PIN#0")).toBeUndefined();
  });
  it("does not treat receive enrollment as execution or startup-capacity authorization", async () => {
    for (const patch of [
      { researchExecutionEnabled: false },
      { startupCapacityValidated: false },
    ]) {
      const f = await submissionFixture();
      let calls = 0;
      await f.store.put({ ...f.enrollment, ...patch, version: 1 }, 0);
      await expect(
        submitResearchPin(f.store, f.submitBinding, f.request, {
          preflight: async () => {
            calls++;
          },
          send: async () => {
            calls++;
            return "bad";
          },
        }),
      ).rejects.toThrow("enrollment");
      expect(calls).toBe(0);
      expect(await f.store.get(f.pk, "PIN#0")).toBeUndefined();
    }
  });
});

async function uncertainResearchFixture() {
  const f = await submissionFixture();
  await expect(
    submitResearchPin(f.store, f.submitBinding, f.request, {
      preflight: async () => {},
      send: async () => {
        throw Error("lost acknowledgement");
      },
    }),
  ).rejects.toThrow();
  const raw = JSON.parse(
    readFileSync(
      "research/yukon-intake/20260924/runtime/remote-queue/result-0.json",
      "utf8",
    ),
  );
  return { ...f, raw };
}
describe("known-ID reconciliation after uncertain research submission", () => {
  it("binds real saved queue evidence and CPU verification before attaching the ID without resubmission", async () => {
    const f = await uncertainResearchFixture();
    let reads = 0;
    const receipt = await reconcileResearchPin(
      f.store,
      f.binding,
      f.raw.id,
      async (endpoint, id) => {
        reads++;
        expect(endpoint).toBe("synthetic-endpoint");
        expect(id).toBe(f.raw.id);
        return f.raw;
      },
    );
    expect(reads).toBe(1);
    expect(receipt.rangeCreditGranted).toBe(false);
    const r = await f.store.get(f.pk, "PIN#0");
    expect(r?.provider).toBe(f.raw.id);
    expect(r?.researchReconciliation).toEqual(receipt);
    expect((await f.store.get(f.pk, "SCOPE"))?.phase).toBe("pinning_searching");
  });
  it("preserves a late ID after pause and release revocation without resuming or publishing", async () => {
    const f = await uncertainResearchFixture();
    const s = (await f.store.get(f.pk, "SCOPE"))!;
    await f.store.put(
      { ...s, version: s.version + 1, revision: 2, phase: "paused" },
      s.version,
    );
    await f.store.put({ ...f.enrollment, version: 1, enabled: false }, 0);
    await reconcileResearchPin(f.store, f.binding, f.raw.id, async () => f.raw);
    expect((await f.store.get(f.pk, "PIN#0"))?.state).toBe("attached");
    expect((await f.store.get(f.pk, "SCOPE"))?.phase).toBe("paused");
    await expect(
      receiveResearchPin(f.store, f.binding, f.raw),
    ).rejects.toThrow();
  });
  it("retains uncertainty for missing, nonterminal or substituted provider evidence", async () => {
    for (const kind of ["missing", "pending", "foreign", "input"]) {
      const f = await uncertainResearchFixture(),
        before = await f.store.get(f.pk, "PIN#0");
      await expect(
        reconcileResearchPin(f.store, f.binding, f.raw.id, async () => {
          if (kind === "missing") throw Error("404");
          const raw = structuredClone(f.raw);
          if (kind === "pending") raw.status = "IN_PROGRESS";
          if (kind === "foreign") raw.id = "other";
          if (kind === "input") raw.output.inputSha256 = "f".repeat(64);
          return raw;
        }),
      ).rejects.toThrow();
      expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
    }
  });
  it("rejects an endpoint change during the provider read before identity journaling", async () => {
    const f = await uncertainResearchFixture(),
      before = await f.store.get(f.pk, "PIN#0");
    await expect(
      reconcileResearchPin(f.store, f.binding, f.raw.id, async () => {
        const s = (await f.store.get(f.pk, "SCOPE"))!;
        await f.store.put(
          { ...s, version: s.version + 1, endpoint: "other" },
          s.version,
        );
        return f.raw;
      }),
    ).rejects.toThrow("context changed");
    expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
  });
});

describe("release-fenced subset handoff", () => {
  async function enrolledWinner() {
    const f = await drainingFixture();
    for (const sk of ["SCOPE", "PIN#0"]) {
      const row = (await f.store.get(f.pk, sk))!;
      const frozen =
        sk === "PIN#0"
          ? JSON.stringify({
              ...JSON.parse(row.frozen as string),
              binarySha256: PIN_RESEARCH_RELEASE.binarySha256,
            })
          : undefined;
      await f.store.put(
        {
          ...row,
          version: row.version + 1,
          researchReleaseId: PIN_RESEARCH_RELEASE_ID,
          ...(frozen ? { frozen } : {}),
        },
        row.version,
      );
    }
    const release = {
      pk: PIN_RESEARCH_RELEASE_PK,
      sk: PIN_RESEARCH_RELEASE_ID,
      version: 0,
      enabled: true,
      descriptor: PIN_RESEARCH_RELEASE,
      endpoint: "synthetic-endpoint",
      scopes: [f.binding.scope],
    };
    await f.store.put(release);
    return { ...f, release };
  }
  it("fences handoff against release revocation during the final drain observation", async () => {
    const f = await enrolledWinner();
    // Synthetic CPU export isolates the release transaction race, not cryptography.
    const mock = vi
      .spyOn(pinVerifier, "createPinHandoff")
      .mockReturnValue(async () => f.handoff);
    try {
      await expect(
        handoffResearchPin(f.store, f.binding, async () => {
          await f.store.put({ ...f.release, version: 1, enabled: false }, 0);
          return f.observe();
        }),
      ).rejects.toThrow();
      expect((await f.store.get(f.pk, "SCOPE"))?.phase).toBe(
        "pinning_draining",
      );
      expect((await f.store.get(f.pk, "PIN#0"))?.state).toBe(
        "research_result_verified",
      );
    } finally {
      mock.mockRestore();
    }
  });
  it("prepares once under the same enrollment without authorizing dispatch", async () => {
    const f = await enrolledWinner();
    const mock = vi
      .spyOn(pinVerifier, "createPinHandoff")
      .mockReturnValue(async () => f.handoff);
    try {
      const got = await handoffResearchPin(f.store, f.binding, f.observe);
      expect(got.dispatchAuthorized).toBe(false);
      await expect(
        handoffResearchPin(f.store, f.binding, f.observe),
      ).rejects.toThrow();
    } finally {
      mock.mockRestore();
    }
  });
  it("rejects an already revoked enrollment before invoking CPU export", async () => {
    const f = await enrolledWinner();
    await f.store.put({ ...f.release, version: 1, enabled: false }, 0);
    const mock = vi.spyOn(pinVerifier, "createPinHandoff");
    try {
      await expect(
        handoffResearchPin(f.store, f.binding, f.observe),
      ).rejects.toThrow("Research release");
      expect(mock).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
    }
  });
});

describe("attached research sibling terminal reconciliation", () => {
  async function drainingAttached() {
    const f = await enrolledRemoteReplay();
    const s = (await f.store.get(f.pk, "SCOPE"))!;
    await f.store.put(
      { ...s, version: s.version + 1, phase: "pinning_draining" },
      s.version,
    );
    return f;
  }
  it("records terminal status once after revocation without credit or phase advancement", async () => {
    for (const status of ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]) {
      const f = await drainingAttached();
      await f.store.put({ ...f.enrollment, version: 1, enabled: false }, 0);
      await recordResearchPinTerminal(
        f.store,
        f.binding,
        async (endpoint, id) => {
          expect(endpoint).toBe("synthetic-endpoint");
          expect(id).toBe(f.raw.id);
          return { id, status };
        },
      );
      expect((await f.store.get(f.pk, "SCOPE"))?.phase).toBe(
        "pinning_draining",
      );
      expect((await f.store.get(f.pk, "PIN#0"))?.terminal).toMatchObject({
        id: f.raw.id,
        status,
      });
      expect(
        (await f.store.get(f.pk, "PIN#0"))?.researchTerminalReceipt,
      ).toMatchObject({ rangeCreditGranted: false, candidateVerified: false });
      let reads = 0;
      await expect(
        recordResearchPinTerminal(f.store, f.binding, async () => {
          reads++;
          return {};
        }),
      ).rejects.toThrow();
      expect(reads).toBe(0);
    }
  });
  it("keeps pause revision intact while retaining old intent terminal evidence", async () => {
    const f = await drainingAttached();
    const s = (await f.store.get(f.pk, "SCOPE"))!;
    await f.store.put(
      { ...s, version: s.version + 1, phase: "paused", revision: 2 },
      s.version,
    );
    await recordResearchPinTerminal(f.store, f.binding, async () => ({
      id: f.raw.id,
      status: "CANCELLED",
    }));
    expect(await f.store.get(f.pk, "SCOPE")).toMatchObject({
      phase: "paused",
      revision: 2,
    });
  });
  it("rejects missing, pending and substituted status without changing either row", async () => {
    for (const response of [
      null,
      { id: "wrong", status: "COMPLETED" },
      { status: "COMPLETED" },
      { id: "placeholder", status: "IN_PROGRESS" },
    ]) {
      const f = await drainingAttached();
      const before = fingerprint([
        await f.store.get(f.pk, "SCOPE"),
        await f.store.get(f.pk, "PIN#0"),
      ]);
      await expect(
        recordResearchPinTerminal(f.store, f.binding, async () => response),
      ).rejects.toThrow();
      expect(
        fingerprint([
          await f.store.get(f.pk, "SCOPE"),
          await f.store.get(f.pk, "PIN#0"),
        ]),
      ).toBe(before);
      await expect(
        recordResearchPinTerminal(f.store, f.binding, async () => {
          throw Error("HTTP404");
        }),
      ).rejects.toThrow("HTTP404");
      expect(
        fingerprint([
          await f.store.get(f.pk, "SCOPE"),
          await f.store.get(f.pk, "PIN#0"),
        ]),
      ).toBe(before);
    }
  });
  it("rejects scope or global identity changes while reading the provider", async () => {
    for (const change of ["scope", "claim"]) {
      const f = await drainingAttached();
      const before = await f.store.get(f.pk, "PIN#0");
      await expect(
        recordResearchPinTerminal(f.store, f.binding, async () => {
          if (change === "scope") {
            const s = (await f.store.get(f.pk, "SCOPE"))!;
            await f.store.put(
              { ...s, version: s.version + 1, endpoint: "changed" },
              s.version,
            );
          } else {
            const claim = (await f.store.get(
              "VALIDATION#YUKON_PROVIDER_IDS",
              createHash("sha256").update(f.raw.id).digest("hex"),
            ))!;
            await f.store.put(
              { ...claim, version: claim.version + 1, scope: "other" },
              claim.version,
            );
          }
          return { id: f.raw.id, status: "CANCELLED" };
        }),
      ).rejects.toThrow();
      expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
    }
  });
  it("never consumes searching results as cleanup or resolves uncertain IDs", async () => {
    const f = await enrolledRemoteReplay();
    let reads = 0;
    await expect(
      recordResearchPinTerminal(f.store, f.binding, async () => {
        reads++;
        return f.raw;
      }),
    ).rejects.toThrow();
    const s = (await f.store.get(f.pk, "SCOPE"))!,
      r = (await f.store.get(f.pk, "PIN#0"))!;
    await f.store.put(
      { ...s, version: s.version + 1, phase: "pinning_draining" },
      s.version,
    );
    await f.store.put(
      { ...r, version: r.version + 1, state: "uncertain" },
      r.version,
    );
    await expect(
      recordResearchPinTerminal(f.store, f.binding, async () => {
        reads++;
        return f.raw;
      }),
    ).rejects.toThrow();
    expect(reads).toBe(0);
  });
});
