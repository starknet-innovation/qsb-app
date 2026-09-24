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
import { PinInventoryV3 } from "../../supervised/runtime/source/work/yukon-indexed-pin-20260923/pin-inventory-v3";
import { SCHEMA } from "../../supervised/runtime/source/work/yukon-indexed-controller-20260923/identity-index";
import { publishResearchPin } from "./pin_store";

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
const context = {
  publicStateJson: "synthetic restart fixture; mocked CPU",
  manifest: { synthetic: true },
};
const request = {
  protocol: "qsb-yukon-pinning-research-v1",
  requestId: "restart-test",
  manifestHash: fingerprint(context.manifest),
  binarySha256: "a".repeat(64),
  parameterSha256: "b".repeat(64),
  parameterBase64: "synthetic",
  range: {
    sequence: 2147483648,
    sequenceCount: 1,
    locktime: 500000000,
    locktimeCount: 1,
  },
};
const { parameterBase64: _, ...fields } = request;
const provider = {
  id: "synthetic-completed-provider",
  status: "COMPLETED",
  output: {
    ...fields,
    status: "range-drained",
    candidates: [{ sequence: 2147483648, locktime: 500000000, recid: 0 }],
    verified: false,
    rangeCreditEligible: false,
    releaseStatus: "HOLD",
  },
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
const scope = (kind: string) => "isolated-yukon-restart-" + kind;
const binding = {
  scope: scope("complete"),
  owner: "restart-owner",
  revision: 1,
  intent: "PIN#0",
  binarySha256: request.binarySha256,
};
const inventory = (kind: string) =>
  new PinInventoryV3(store, scope(kind), binding.owner, 1);
async function initialize(kind: string) {
  await store.put({
    pk: "VALIDATION#" + scope(kind),
    sk: "SCOPE",
    version: 1,
    owner: binding.owner,
    revision: 1,
    identitySchema: SCHEMA,
    stage: "pinning",
    phase: "pinning_searching",
    publicContext: JSON.stringify(context),
    publicContextHash: fingerprint(context),
    budget: {
      maxConcurrent: 1,
      maxSubmissions: 2,
      claimed: 0,
      deadlineMs: Date.now() + 1800000,
    },
  });
  await inventory(kind).reserve(0, request, async () => {});
}
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
    let sends = 0;
    await initialize("complete");
    await inventory("complete").submit(
      "PIN#0",
      async () => {
        sends++;
        return provider.id;
      },
      async () => {},
    );
    await publishResearchPin(store, binding, provider, async () => verdict);
    await initialize("uncertain");
    await assert.rejects(
      inventory("uncertain").submit(
        "PIN#0",
        async () => {
          sends++;
          throw Error("Simulated lost provider acknowledgement");
        },
        async () => {},
      ),
    );
    const completed = await store.get(
        "VALIDATION#" + scope("complete"),
        "PIN#0",
      ),
      uncertain = await store.get("VALIDATION#" + scope("uncertain"), "PIN#0");
    assert.equal(completed?.state, "research_result_verified");
    assert.equal(uncertain?.state, "uncertain");
    assert.equal(sends, 2);
    writeFileSync(
      receiptFile,
      JSON.stringify(
        {
          table,
          seedProcessId: process.pid,
          completedHash: fingerprint(completed),
          uncertainHash: fingerprint(uncertain),
          syntheticSendCalls: sends,
          scope:
            "Mock transport/CPU, real DynamoStore; database restart still pending",
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
    const completed = await store.get(
        "VALIDATION#" + scope("complete"),
        "PIN#0",
      ),
      uncertain = await store.get("VALIDATION#" + scope("uncertain"), "PIN#0");
    assert.equal(fingerprint(completed), before.completedHash);
    assert.equal(fingerprint(uncertain), before.uncertainHash);
    let sends = 0,
      checks = 0;
    await assert.rejects(
      publishResearchPin(store, binding, provider, async () => {
        checks++;
        return verdict;
      }),
    );
    await assert.rejects(
      inventory("uncertain").submit(
        "PIN#0",
        async () => {
          sends++;
          return "must-not-send";
        },
        async () => {},
      ),
    );
    assert.equal(sends, 0);
    assert.equal(checks, 0);
    assert.equal(
      fingerprint(await store.get("VALIDATION#" + scope("complete"), "PIN#0")),
      before.completedHash,
    );
    assert.equal(
      fingerprint(await store.get("VALIDATION#" + scope("uncertain"), "PIN#0")),
      before.uncertainHash,
    );
    // A reconciled late ID is attached to the original durable intent, never resubmitted.
    const attached = await inventory("uncertain").attach(
      "PIN#0",
      "synthetic-late-provider",
    );
    assert.equal(attached.state, "attached");
    assert.equal(attached.provider, "synthetic-late-provider");
    await assert.rejects(
      inventory("uncertain").submit(
        "PIN#0",
        async () => {
          sends++;
          return "must-not-send";
        },
        async () => {},
      ),
    );
    assert.equal(sends, 0);
    await client.send(new DeleteTableCommand({ TableName: table }));
    writeFileSync(
      receiptFile + ".verified.json",
      JSON.stringify(
        {
          scope:
            "Fresh process after externally performed database restart; mocked provider and CPU",
          completedRowUnchanged: true,
          uncertainRowUnchanged: true,
          duplicatePublicationRejected: true,
          cpuCallsOnDuplicate: checks,
          resubmissionRejected: true,
          providerCallsAfterRestart: sends,
          lateIdentityAttachedToOriginalIntent: true,
          testTableDeleted: true,
          freshProcess: before.seedProcessId !== process.pid,
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
