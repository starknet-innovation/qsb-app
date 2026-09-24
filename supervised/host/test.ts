import assert from "node:assert/strict";
import { MemoryStore } from "../../server/store";
import { hostRegistry, preserveHostEvidence, DISTRIBUTION } from "./claim";
import { processIdentity, singleUse, outputLimiter } from "./process";
const registry = {
  pk: "SYSTEM#QSB_MAINNET_HOST",
  sk: "REGISTRY",
  version: 1,
  enabled: true,
  format: "qsb-fixed-linux-host-v1",
  distributionHash: DISTRIBUTION,
  region: "eu-west-1",
  table: "QsbYukonIsolatedHostTests",
  maxLifetimeMs: 30000,
  maxActions: 1,
  pollIntervalMs: 100,
};
assert.deepEqual(hostRegistry(registry), registry);
for (const version of [
  NaN,
  undefined,
  Infinity,
  0,
  -1,
  1.1,
  Number.MAX_SAFE_INTEGER + 1,
])
  assert.throws(() => hostRegistry({ ...registry, version } as any));
for (const change of [
  { enabled: false },
  { distributionHash: "0".repeat(64) },
  { region: "us-east-1" },
  { table: "qsb-records" },
  { maxLifetimeMs: 1800001 },
  { maxActions: 10001 },
  { pollIntervalMs: 99 },
])
  assert.throws(() => hostRegistry({ ...registry, ...change }));
const store = new MemoryStore();
const claim = {
  pk: "OWNER#test",
  sk: "V5_HOST_LAUNCH#test",
  version: 1,
  requestHash: "request",
  configHash: "config",
  distributionHash: DISTRIBUTION,
  deadlineMs: 100,
  evidenceDirectory: "/evidence/host-test",
} as any;
await store.put(claim);
for (const change of [
  { distributionHash: "changed" },
  { deadlineMs: 101 },
  { evidenceDirectory: "/evidence/other" },
  { version: 2 },
])
  await assert.rejects(() =>
    preserveHostEvidence(store, { ...claim, ...change }, "identity", {
      pid: 1,
    }),
  );
const record = await preserveHostEvidence(store, claim, "identity", { pid: 1 });
assert.deepEqual(
  await preserveHostEvidence(store, claim, "identity", { pid: 1 }),
  record,
);
await assert.rejects(() =>
  preserveHostEvidence(store, claim, "identity", { pid: 2 }),
);
// Lost acknowledgement does not prevent later durable identity and terminal observations.
await preserveHostEvidence(store, claim, "unknown", {
  reason: "acknowledgement timeout",
});
await preserveHostEvidence(store, claim, "terminal", {
  hostChildReaped: true,
  providerCleanupVerified: false,
  searchComplete: false,
});
assert.equal((await store.list(claim.pk, "V5_HOST_LAUNCH#test")).length, 4);
const take = singleUse();
take();
assert.throws(take);
const tail = ["S", "42", "51", ...Array(16).fill("0"), "123456789"];
assert.deepEqual(
  processIdentity("51 (child name ) with spaces) " + tail.join(" ")),
  { parentPid: 42, pgid: 51, startTicks: "123456789" },
);
for (const bad of [
  "garbage",
  "51 (name) S 1 2",
  "51 (name) " + tail.map((x, i) => (i === 19 ? "NaN" : x)).join(" "),
])
  assert.throws(() => processIdentity(bad));
const decode = outputLimiter(8);
assert.deepEqual(decode(Buffer.from("a\nb\n")), ["a", "b"]);
assert.deepEqual(decode(Buffer.from("c\n")), ["c"]);
assert.throws(() => decode(Buffer.from("def")));
assert.deepEqual(decode(Buffer.alloc(100000)), []);
console.log(
  "Host pure guard/evidence controls passed: invalid registry versions, immutable claims, late evidence, one-use pipe, proc names, total output cap. No host spawn/provider calls.",
);
