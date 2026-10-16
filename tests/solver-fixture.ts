import { CURRENT_SCRIPT_VERSION, CORRECTED_GENERATOR_COMMIT } from "../src/lib/script-version";
import { createHash } from "node:crypto";
import contract from "../contracts/ranked-v2.json";
import archived from "../src/lib/releases/qsb-config-a-ranked-v2.json";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
// Test-only enrolled releases. No production descriptor or image is created.
export const servedFixture = {
  schemaVersion: 4, scriptVersion: CURRENT_SCRIPT_VERSION, id:"served-test", protocol:"qsb-config-a-v1",
  generatorCommit:CORRECTED_GENERATOR_COMMIT, searchVersion:"ranked-v2",
  searchContract:createHash("sha256").update(canonical(contract)).digest("hex"),
  solverRepository:"https://github.com/starknet-innovation/qsb-solver",
  solverCommit:"a".repeat(40),kernelCommit:archived.kernelCommit,
  image:"ghcr.io/starknet-innovation/qsb-solver@sha256:"+"c".repeat(64),
};
export const otherFixture = {...servedFixture,id:"external-test",kernelCommit:"b".repeat(40)};
export { publicScriptFixture, fixtureVault } from "./script-fixture";
