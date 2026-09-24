/** Two-process DynamoDB Local restart check; no real provider or funded fixture. */
import { strict as assert } from "node:assert";
import { writeFileSync, readFileSync } from "node:fs";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoStore } from "../../server/store";
import { fingerprint } from "../../src/lib/provenance";
import { SCHEMA } from "../../supervised/runtime/source/work/yukon-indexed-controller-20260923/identity-index";
import { submitResearchPin } from "./pin_submit";
import { reconcileResearchPin } from "./pin_reconcile";
import {
  receiveResearchPin,
  PIN_RESEARCH_RELEASE,
  PIN_RESEARCH_RELEASE_ID,
  PIN_RESEARCH_RELEASE_PK,
} from "./pin_route";

const [action, table, receiptFile] = process.argv.slice(2),
  endpoint = process.env.QSB_PIN_TEST_DYNAMODB;
if (
  !["seed", "verify"].includes(action) ||
  !/^qsb-pin-restart-[a-z0-9-]+$/.test(table ?? "") ||
  !receiptFile ||
  !endpoint ||
  !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(endpoint) ||
  process.env.AWS_ENDPOINT_URL_DYNAMODB !== endpoint ||
  process.env.AWS_ACCESS_KEY_ID !== "qsbLocalDummy" ||
  process.env.AWS_SECRET_ACCESS_KEY !== "qsbLocalDummy" ||
  process.env.AWS_SESSION_TOKEN ||
  process.env.AWS_REGION !== "us-east-1"
)
  throw Error("Explicit dummy-credential loopback restart test required");
const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: {
      accessKeyId: "qsbLocalDummy",
      secretAccessKey: "qsbLocalDummy",
    },
  }),
  store = new DynamoStore(table);
const base = "research/yukon-intake/20260924/runtime/remote-queue/";
const load = (file: string) => JSON.parse(readFileSync(base + file, "utf8"));
const context = load("context-0.json"),
  request = load("input-0.json").request,
  provider = load("result-0.json");
const binding = {
  scope: "isolated-yukon-route-restart",
  owner: "restart-owner",
  revision: 1,
  attempt: 0,
  intent: "PIN#0",
};
const pk = "VALIDATION#" + binding.scope;
const enrollment = {
  pk: PIN_RESEARCH_RELEASE_PK,
  sk: PIN_RESEARCH_RELEASE_ID,
  version: 0,
  enabled: true,
  researchExecutionEnabled: true,
  startupCapacityValidated: true,
  descriptor: PIN_RESEARCH_RELEASE,
  endpoint: "synthetic-endpoint",
  scopes: [binding.scope],
};
try {
  if (action === "seed") {
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
    await store.put({
      pk,
      sk: "SCOPE",
      version: 1,
      owner: binding.owner,
      revision: 1,
      identitySchema: SCHEMA,
      stage: "pinning",
      phase: "pinning_searching",
      researchReleaseId: PIN_RESEARCH_RELEASE_ID,
      endpoint: enrollment.endpoint,
      publicContext: JSON.stringify(context),
      publicContextHash: fingerprint(context),
      budget: {
        maxConcurrent: 1,
        maxSubmissions: 1,
        claimed: 0,
        deadlineMs: Date.now() + 1800000,
      },
    });
    await store.put(enrollment);
    let sends = 0;
    await assert.rejects(
      submitResearchPin(store, binding, request, {
        preflight: async () => {},
        send: async () => {
          sends++;
          throw Error("Simulated lost acknowledgement");
        },
      }),
    );
    const intent = await store.get(pk, "PIN#0");
    assert.equal(intent?.state, "uncertain");
    assert.equal(sends, 1);
    assert.ok(Number.isSafeInteger(intent?.dispatchAuthorizedAtMs));
    writeFileSync(
      receiptFile,
      JSON.stringify(
        {
          table,
          seedProcessId: process.pid,
          intentHash: fingerprint(intent),
          scopeHash: fingerprint(await store.get(pk, "SCOPE")),
          enrollmentHash: fingerprint(
            await store.get(PIN_RESEARCH_RELEASE_PK, PIN_RESEARCH_RELEASE_ID),
          ),
          mockedPaidCalls: 1,
          realCpuPreflight: true,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  } else {
    const before = JSON.parse(readFileSync(receiptFile, "utf8"));
    assert.equal(before.table, table);
    assert.notEqual(before.seedProcessId, process.pid);
    assert.equal(fingerprint(await store.get(pk, "PIN#0")), before.intentHash);
    assert.equal(fingerprint(await store.get(pk, "SCOPE")), before.scopeHash);
    assert.equal(
      fingerprint(
        await store.get(PIN_RESEARCH_RELEASE_PK, PIN_RESEARCH_RELEASE_ID),
      ),
      before.enrollmentHash,
    );
    let sends = 0,
      reads = 0;
    await assert.rejects(
      submitResearchPin(store, binding, request, {
        preflight: async () => {},
        send: async () => {
          sends++;
          return "must-not-send";
        },
      }),
    );
    assert.equal(sends, 0);
    assert.equal(fingerprint(await store.get(pk, "PIN#0")), before.intentHash);
    const scope = (await store.get(pk, "SCOPE"))!;
    await store.put(
      { ...scope, version: scope.version + 1, phase: "paused", revision: 2 },
      scope.version,
    );
    await store.put({ ...enrollment, version: 1, enabled: false }, 0);
    const receipt = await reconcileResearchPin(
      store,
      binding,
      provider.id,
      async (endpoint, id) => {
        reads++;
        assert.equal(endpoint, enrollment.endpoint);
        assert.equal(id, provider.id);
        return provider;
      },
    );
    assert.equal(reads, 1);
    assert.equal((await store.get(pk, "PIN#0"))?.provider, provider.id);
    assert.equal((await store.get(pk, "SCOPE"))?.phase, "paused");
    assert.equal(receipt.rangeCreditGranted, false);
    await assert.rejects(receiveResearchPin(store, binding, provider));
    await client.send(new DeleteTableCommand({ TableName: table }));
    writeFileSync(
      receiptFile + ".verified.json",
      JSON.stringify(
        {
          scope:
            "New Node coordinator process after externally performed DynamoDB Local restart; actual CPU verification; mocked provider transport/status read",
          freshProcess: true,
          persistedIntentScopeEnrollmentUnchanged: true,
          duplicateSubmitRejected: true,
          paidCallsAfterRestart: sends,
          savedProviderReads: reads,
          lateIdentityAttached: true,
          pausePreserved: true,
          revokedPublicationRejected: true,
          reconciliationReceipt: receipt,
          testTableDeleted: true,
          gpuExecuted: false,
          awsRegionalCertification: false,
          freshWithdrawal: false,
          releaseStatus: "HOLD",
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  }
} finally {
  client.destroy();
}
