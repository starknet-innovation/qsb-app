import { expect, it, vi } from "vitest";
vi.mock("../src/lib/releases/registry.generated", async () => {
  const { servedFixture } = await import("./solver-fixture");
  return { default: [servedFixture] };
});
import { buildIdentities, referenceFiles } from "../server/build-identities";
import { fingerprint } from "../src/lib/provenance";
import { servedFixture } from "./solver-fixture";
const appCommit = "e".repeat(40), cpuDigest = "f".repeat(64);
it("binds the selected enrolled solver and actual CPU artifact under their separate source commits", () => {
  expect(buildIdentities(servedFixture.id, appCommit, cpuDigest)).toEqual({
    solver: { id: servedFixture.id, image: servedFixture.image, solverCommit: servedFixture.solverCommit, descriptorHash: fingerprint(servedFixture) },
    reference: { appCommit, artifact: "reference.zip", sha256: cpuDigest },
  });
});
it("keeps an unconfigured build explicitly without a solver", () => {
  expect(buildIdentities("", appCommit, cpuDigest).solver).toBeNull();
});
it.each(["unknown", "qsb-config-a-ranked-v2-2791ed0"])("rejects unenrolled or archived paid selection %s", (id) => {
  expect(() => buildIdentities(id, appCommit, cpuDigest)).toThrow();
});
it.each([["main", cpuDigest], [appCommit, "not-a-digest"]])("rejects invalid build identities", (commit, digest) => {
  expect(() => buildIdentities("", commit, digest)).toThrow("InvalidBuildIdentity");
});

it("excludes ignored Python modules outside the committed CPU closure", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "qsb-reference-files-"));
  try {
    execFileSync("git", ["init", "--quiet"], {cwd: root});
    mkdirSync(join(root, "worker/cpu"), {recursive: true});
    writeFileSync(join(root, ".gitignore"), "worker/cpu/json.py\n");
    writeFileSync(join(root, "worker/cpu/handler.py"), "# committed handler\n");
    writeFileSync(join(root, "worker/cpu/LICENSE"), "license\n");
    execFileSync("git", ["add", "."], {cwd: root});
    writeFileSync(join(root, "worker/cpu/json.py"), "# ignored module shadowing standard library\n");
    expect(referenceFiles(root)).toEqual(["worker/cpu/LICENSE", "worker/cpu/handler.py"]);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
