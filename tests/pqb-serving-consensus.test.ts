import { describe, expect, it } from "vitest";
import { mutateCoSignature } from "../ops/pqb-serving/consensus-signature";
import reference from "./fixtures/pqb-reference.json";
import { buildLock } from "../src/pqb-core/lock";
import { concat, fromHex } from "../src/pqb-core/primitives";
import { pushData } from "../src/pqb-core/l1gen";
import { cosigSign } from "../src/pqb-core/spend";
import { parseScript } from "../src/pqb-core/tx";

import { retainedOnlyChanges } from "../ops/pqb-serving/consensus-retained";

const lock = buildLock("PQB", fromHex(reference.seed));
const earlier = cosigSign(lock.detail.cosig.d, 123n);
const sig = cosigSign(lock.detail.cosig.d, 456n);
const pk = lock.detail.cosig.pk;
const script = concat(pushData(earlier), pushData(pk), pushData(sig), pushData(pk));
describe("retained PQB co-signature mutation", () => {
  it("mutates the final signature when two long DER signatures are present", () => {
    expect(earlier.length).toBeGreaterThanOrEqual(64);
    expect(sig.length).toBeGreaterThanOrEqual(64);
    const changed = mutateCoSignature(script, lock.script);
    const positions = [...script.keys()].filter(i => script[i] !== changed[i]);
    const tail = parseScript(script).at(-2)!;
    expect(positions).toEqual([tail[0] + tail[3] - 2]);
    expect(parseScript(changed)[0][2]).toEqual(earlier);
    expect(parseScript(changed).at(-1)![2]).toEqual(pk);
    expect(script).toEqual(concat(pushData(earlier), pushData(pk), pushData(sig), pushData(pk)));
  });
  it("rejects absent or misplaced keys, wrong sighash and malformed DER", () => {
    const wrongKey = pk.slice(); wrongKey[1] ^= 1;
    const wrongType = sig.slice(); wrongType[wrongType.length - 1] = 3;
    const badDer = sig.slice(); badDer[1] ^= 1;
    for (const candidate of [new Uint8Array(), concat(pushData(sig)),
      concat(pushData(pk), pushData(sig)), concat(pushData(sig), pushData(wrongKey)),
      concat(pushData(wrongType), pushData(pk)), concat(pushData(badDer), pushData(pk))])
      expect(() => mutateCoSignature(candidate, lock.script)).toThrow();
  });
});

it("allows a checker-only follow-up and rejects application, build and fixture changes", () => {
  expect(retainedOnlyChanges(["ops/pqb-serving/consensus-signature.ts", "docs/PQB.md"])).toBe(true);
  for (const f of ["src/lib/pqb.ts", "tests/fixtures/pqb-reference.json", "package-lock.json", "terraform/scripts/build.mjs",
    "ops/pqb-serving/control.py", "server/coordinator.ts"])
    expect(retainedOnlyChanges([f])).toBe(false);
});

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { retainedContext } from "../ops/pqb-serving/consensus-retained";

it("binds a retained follow-up to cleanup, sealed bytes and the actual coordinator solution", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pqb-retained-"));
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const job = { id: "public-job", manifest: { public: true }, manifestHash: "manifest", solution: { nonce: 1 } };
  const put = (f: string, x: unknown) => writeFileSync(path.join(root, f), JSON.stringify(x));
  const binding = (f: string) => ({ file: f, sha256: sha(readFileSync(path.join(root, f))) });
  try {
    // The reader's retained layout deliberately includes the same immutable build directory shape.
    // No cloud operation or native work is performed in this evidence-consistency test.
    mkdirSync(path.join(root, "build-artifacts"));
    put("build-artifacts/manifest.json", { clean: true, commit });
    put("build-artifacts/api.zip", "test-artifact");
    put("public-fixture.json", { public: true });
    const sealedRow: { tables: Record<string, { pages: Array<{ Items: unknown[] }> }> } = { tables: { solve: { pages: [{ Items: [{ job: { M: {
      id: { S: job.id }, manifest: { M: { public: { BOOL: true } } }, manifestHash: { S: job.manifestHash },
      solution: { M: { nonce: { N: "1" } } },
    } } }] }] } } };
    sealedRow.tables.preflight = structuredClone(sealedRow.tables.solve);
    put("final-resources-1.json", sealedRow);
    const files = Object.fromEntries(["build-artifacts/manifest.json", "build-artifacts/api.zip", "public-fixture.json",
      "final-resources-1.json"].map(f => [f, binding(f).sha256]));
    put("seal.json", { name: "test", sourceCommit: commit, executions: { public: "SUCCEEDED" }, files });
    put("cleanup.json", { verified: true, campaign: "test", sourceCommit: commit, checks: [{ passed: true }] });
    writeFileSync(path.join(root, "solved-synthetic-transaction.hex"), "00\n");
    put("offline-core-solved-pqb-with-public-OP_TRUE-helper.json", {
      accepted: true, expectedValid: true, transactionSha256: sha(Buffer.from("00", "hex")),
    });
    put("offline-consensus-intent.json", { sourceCommit: commit, apiArtifactSha256: "api" });
    const campaign = { tables: ["preflight", "solve"], name: "test", sourceCommit: commit, reservationStatus: "released", apiArtifactSha256: "api",
      independentCleanup: binding("cleanup.json"), finalCollection: binding("seal.json") };
    expect(retainedContext(root, campaign, job, commit).originalRaw).toBe("00");
    expect(() => retainedContext(root, { ...campaign, reservationStatus: "reserved" }, job, commit)).toThrow("cleanup");
    expect(() => retainedContext(root, campaign, { ...job, solution: { nonce: 2 } }, commit)).toThrow("sealed coordinator");
    put("public-fixture.json", { public: false });
    expect(() => retainedContext(root, campaign, job, commit)).toThrow("Sealed evidence changed");
    put("cleanup.json", { verified: false });
    expect(() => retainedContext(root, campaign, job, commit)).toThrow("changed retained receipt");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
