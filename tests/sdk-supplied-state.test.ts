import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { loadPyodide } from "pyodide";
import { startQsbRuntime } from "../src/lib/qsb-runtime";
import awsRelease from "../src/lib/releases/qsb-solver-aws-v0-1-0.json";
import { decryptRecovery } from "../src/lib/backup";
import { RefusedState, nodeQsb, type LocalQsb } from "./recovery-runtime";
import { runCli } from "../sdk/cli";
import { API, wallet, world } from "./sdk-fixture";

/**
 * While `bridge` is set, the runtime reads a damaged install: "altered" no longer matches the
 * manifest; "failing" is listed in it, but its setup raises after adopt's checks pass.
 */
const damaged = vi.hoisted(() => ({ bridge: undefined as "altered" | "failing" | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { createHash } = await import("node:crypto");
  const failing = async () =>
    Buffer.concat([
      await actual.readFile(new URL("../public/qsb/bridge.py", import.meta.url)),
      Buffer.from("\ndef setup(secrets=None):\n    raise ValueError('setup failed')\n"),
    ]);
  const readFile = (async (file: Parameters<typeof actual.readFile>[0], ...rest: [never]) => {
    const name = String(file);
    if (damaged.bridge === "altered" && name.endsWith("/qsb/bridge.py")) return Buffer.from("import os\n");
    if (damaged.bridge === "failing" && name.endsWith("/qsb/bridge.py")) return failing();
    if (damaged.bridge === "failing" && name.endsWith("/qsb/manifest.json")) {
      const manifest = JSON.parse(String(await actual.readFile(file)));
      return Buffer.from(JSON.stringify({ ...manifest, "bridge.py": createHash("sha256").update(await failing()).digest("hex") }));
    }
    return actual.readFile(file, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, readFile };
});
/** What the SDK's own runtimes check and re-open, in order with the vault requests the transport sees. */
const events = vi.hoisted(() => [] as string[]);
vi.mock("./recovery-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./recovery-runtime")>();
  return {
    ...actual,
    nodeQsb: () => {
      const qsb = actual.nodeQsb();
      return {
        ...qsb,
        adoptQsb: async (stateJson: string) => {
          events.push("adopt");
          return qsb.adoptQsb(stateJson);
        },
        validateRecovery: async (stateJson: string) => {
          const scriptHash = await qsb.validateRecovery(stateJson);
          events.push(`re-open ${scriptHash}`);
          return scriptHash;
        },
      };
    },
  };
});

beforeEach(() => vi.stubEnv("SOLVER_RELEASE_ID", awsRelease.id));
afterEach(() => vi.unstubAllEnvs());
const passphrase = "disposable supplied state passphrase";

type Generated = Awaited<ReturnType<LocalQsb["generateQsb"]>>;
/** State made outside the client under test, as a caller's own generator would. */
let generated: Generated;
beforeAll(async () => {
  const qsb = nodeQsb();
  generated = await qsb.generateQsb();
  qsb.lockQsb();
}, 60000);

/** A Python with the pinned sources loaded as the SDK's runtime loads them, to run the pipeline directly. */
async function pipelinePython() {
  const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
  await startQsbRuntime(py, async (file) => new Uint8Array(await readFile(new URL(`../public/qsb/${file}`, import.meta.url))));
  return py;
}
/** What the bridge's own setup builds from `secrets`, as generateQsb returns it. */
async function generatedFrom(secrets: string[]): Promise<Generated> {
  const py = await pipelinePython();
  py.globals.set("secrets", JSON.stringify(secrets));
  return JSON.parse(py.runPython("import bridge, json\nbridge.result(bridge.setup([bytes.fromhex(s) for s in json.loads(secrets)]))"));
}
/** The two files the pipeline's `setup --config A` writes: the state a caller passes, and its script. */
async function setupFiles(): Promise<[string, string]> {
  const py = await pipelinePython();
  return py
    .runPython(
      "import contextlib, io, qsb_pipeline\nfrom types import SimpleNamespace\nwith contextlib.redirect_stdout(io.StringIO()):\n    qsb_pipeline.cmd_setup(SimpleNamespace(config='A', seed=None))\n[open(f).read() for f in ('qsb_state.json', 'qsb_scriptpubkey.hex')]",
    )
    .toJs();
}

const replaceOnce = (text: string, from: string, to: string) => {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, to);
};
const hash160 = (bytes: Uint8Array) => hex.encode(ripemd160(sha256(bytes)));
const derived = (field: string) =>
  new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not what the pipeline builds from these HORS secrets$`);
/**
 * Mismatched states and what the bridge says about each. The edits are made on the JSON text: the
 * state holds integers above 2^53 (pin_r, pin_s, pin_k, each round's r, s and k) that JavaScript numbers round.
 */
function edits(stateJson: string): [string, string, RegExp][] {
  const state = JSON.parse(stateJson) as { hors_secrets: string[][]; hors_commitments: string[][]; pin_sig: string; full_script_hex: string };
  const secret = hex.encode(randomBytes(20));
  const script = state.full_script_hex;
  // The secret and its commitment agree, but the script still holds the old commitment.
  const swapped = replaceOnce(
    replaceOnce(stateJson, `"${state.hors_secrets[0][5]}"`, `"${secret}"`),
    `"${state.hors_commitments[0][5]}"`,
    `"${hash160(hex.decode(secret))}"`,
  );
  return [
    ["a tampered secret", replaceOnce(stateJson, `"${state.hors_secrets[0][17]}"`, `"${secret}"`), derived("hors_commitments[0][17]")],
    ["a tampered commitment", replaceOnce(stateJson, `"${state.hors_commitments[1][3]}"`, `"${hash160(randomBytes(20))}"`), derived("hors_commitments[1][3]")],
    ["a script the commitments don't build", swapped, derived("full_script_hex")],
    ["an edited script", replaceOnce(stateJson, `"${script}"`, `"${script.slice(0, -2)}${script.endsWith("00") ? "01" : "00"}"`), derived("full_script_hex")],
    ["integers rounded by JavaScript", JSON.stringify(JSON.parse(stateJson)), derived("pin_r")],
    ["a changed type", replaceOnce(stateJson, `"pin_sig": "${state.pin_sig}"`, `"pin_sig": ["${state.pin_sig}"]`), derived("pin_sig")],
    ["a private field", stateJson.replace(/^\{/, '{"pin_privkey": 1, '), /^pin_privkey is not a field the pipeline produces$/],
    ["a private round field", replaceOnce(stateJson, '"round_sigs": [{', '"round_sigs": [{"seed": "00", '), /^round_sigs\[0\]\.seed is not a field the pipeline produces$/],
    ["a missing field", stateJson.replace(/"dummy_sigs": \[\[[^\]]*\], \[[^\]]*\]\], /, ""), /^dummy_sigs is missing$/],
    ["a repeated secret", replaceOnce(stateJson, `"${state.hors_secrets[1][9]}"`, `"${state.hors_secrets[0][2]}"`), /^a HORS secret repeats$/],
    ["an uppercase secret", replaceOnce(stateJson, `"${state.hors_secrets[0][0]}"`, `"${state.hors_secrets[0][0].toUpperCase()}"`), /^a HORS secret is not 20 bytes of lowercase hex$/],
    ["another configuration", replaceOnce(stateJson, '"n": 150,', '"n": 140,'), /^n is not Config A's 150$/],
    ["a configuration of another type", replaceOnce(stateJson, '"t1b": 1,', '"t1b": true,'), /^t1b is not Config A's 1$/],
    ["no secrets", replaceOnce(stateJson, '"hors_secrets"', '"secrets"'), /^hors_secrets is missing$/],
    ["a short round of secrets", replaceOnce(stateJson, `, "${state.hors_secrets[1][149]}"]`, "]"), /^hors_secrets is not 2 rounds of 150 secrets$/],
    ["a repeated key", stateJson.replace(/^\{/, '{"hors_secrets": [[], []], '), /^hors_secrets appears twice in one object$/],
    ["a key that isn't a plain name", stateJson.replace(/^\{/, '{"a\\nValueError: x": 1, '), /^"a\\nValueError: x" is not a field the pipeline produces$/],
    ["not an object", "[]", /^the recovery state is not a JSON object$/],
    ["not JSON", stateJson.slice(0, -1), /^the recovery state is not JSON this check reads \(.+\)$/],
    ["an integer too long to read", stateJson.replace(/^\{/, `{"pin_x": ${"9".repeat(5000)}, `), /^the recovery state is not JSON this check reads \(.+\)$/],
    ["deep nesting", `${"[".repeat(5000)}${"]".repeat(5000)}`, /^the recovery state nests deeper than the pipeline's state$/],
  ];
}

describe("adoptQsb in the SDK's bundled runtime", () => {
  it("returns exactly what generateQsb returned for a state, and names what differs in any other", async () => {
    const qsb = nodeQsb();
    try {
      expect(await qsb.adoptQsb(generated.stateJson)).toEqual(generated);
      // Key order and whitespace aren't part of the state.
      const reordered = replaceOnce(generated.stateJson, '{"config": "A", ', "{\n  ").replace(/\}$/, ', "config": "A"}');
      expect(await qsb.adoptQsb(reordered)).toEqual(generated);
      // The file the pipeline's setup writes, indented, as a caller passes it.
      const [file, script] = await setupFiles();
      expect(file).toContain('{\n  "config": "A",\n');
      const adopted = await qsb.adoptQsb(file);
      expect(adopted.scriptHex).toBe(script.trim());
      expect(await qsb.validateRecovery(adopted.stateJson)).toBe(adopted.scriptHash);
      for (const [label, stateJson, message] of edits(generated.stateJson)) {
        const error = await qsb.adoptQsb(stateJson).then(() => new Error(`${label} was accepted`), (e: Error) => e);
        expect(error, label).toBeInstanceOf(RefusedState);
        expect(error.message, label).toMatch(message);
      }
      await expect(qsb.adoptQsb(" ".repeat(1000001))).rejects.toThrow(new RefusedState("the recovery state is larger than the pipeline's state"));
      // A JavaScript caller that passes the parsed object instead of the text.
      await expect(qsb.adoptQsb(JSON.parse(generated.stateJson))).rejects.toThrow(new RefusedState("the recovery state is not JSON text"));
    } finally {
      qsb.lockQsb();
    }
  }, 60000);
});
