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
import { QsbClient, RefusedState, loopbackTestSigner, nodeQsb, type LocalQsb } from "../sdk";
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
vi.mock("../sdk/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sdk/runtime")>();
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

/** A replaced runtime that would wave anything through, or fail if it were asked at all. */
function replacedRuntime() {
  return {
    generateQsb: vi.fn(async () => {
      throw new Error("the replaced runtime generated state");
    }),
    validateRecovery: vi.fn(async () => {
      throw new Error("the replaced runtime validated state");
    }),
    assembleQsb: vi.fn(async () => {
      throw new Error("the replaced runtime assembled");
    }),
    lockQsb: vi.fn(),
  } satisfies LocalQsb;
}
/** A transport that records the vault list and registration requests among `events`. */
const recordVaults = (next: typeof fetch) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/v1/vaults") events.push(init?.method === "POST" ? "register" : "list");
    return next(input, init);
  }) as typeof fetch;
const vaultPosts = (w: ReturnType<typeof world>) =>
  w.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/v1/vaults");

describe("vaults.create with a supplied state", () => {
  async function signedIn(qsb: LocalQsb = replacedRuntime(), wrap = (next: typeof fetch) => next) {
    const w = world();
    const owner = wallet(w.chain);
    const signer = loopbackTestSigner(owner.wif, API);
    const client = new QsbClient({ baseUrl: API, signer, fetch: wrap(w.fetch), qsb });
    await client.login();
    return { w, owner, signer, client };
  }

  it("registers the state's vault, checked and re-opened by the bundled runtime, not the qsb option", async () => {
    const qsb = replacedRuntime();
    const { w, owner, signer, client } = await signedIn(qsb, recordVaults);
    const saveBackup = vi.fn(async (text: string) => void events.push(`save ${text.length}`));
    events.length = 0;
    const { vault, backup } = await client.vaults.create({ name: "own state", passphrase, saveBackup, stateJson: generated.stateJson });
    expect(saveBackup).toHaveBeenCalledExactlyOnceWith(backup);
    // The vaults were listed before the bundled runtime's check, and again after it re-opened the
    // saved backup, before the vault was registered.
    expect(events).toEqual(["list", "adopt", `save ${backup.length}`, `re-open ${generated.scriptHash}`, "list", "register"]);
    expect([vault.scriptHex, vault.scriptHash, vault.publicStateJson]).toEqual([generated.scriptHex, generated.scriptHash, generated.publicStateJson]);
    expect((await decryptRecovery(backup, passphrase)).stateJson).toBe(generated.stateJson);
    for (const call of [qsb.generateQsb, qsb.validateRecovery, qsb.assembleQsb, qsb.lockQsb]) expect(call).not.toHaveBeenCalled();
    // Only the public record went to the server: no secret, nonce or passphrase.
    const [posted] = vaultPosts(w);
    const sent = JSON.parse(JSON.parse(posted.body).publicStateJson);
    expect(Object.keys(sent)).not.toContain("hors_secrets");
    expect(sent.round_sigs.map(Object.keys)).toEqual([["r", "s", "sig"], ["r", "s", "sig"]]);
    const nonces = [...generated.stateJson.matchAll(/"(?:pin_k|k)":\s*(\d+)/g)].map((m) => m[1]);
    expect(nonces).toHaveLength(3);
    for (const value of ["hors_secrets", "pin_k", passphrase, ...nonces, ...JSON.parse(generated.stateJson).hors_secrets.flat()])
      expect(posted.body.includes(value), value).toBe(false);
    // The backup works like a generated vault's from here on.
    const usual = new QsbClient({ baseUrl: API, signer, fetch: w.fetch, token: client.token });
    const prepared = await usual.deposits.prepare(vault.id, {
      backup,
      passphrase,
      amount: 200000n,
      feeRate: "2",
      utxos: [{ txid: owner.fundingTxid, vout: 0 }],
    });
    expect(prepared.scriptHash).toBe(generated.scriptHash);
  }, 120000);

  it("refuses a state that isn't what the pipeline builds from its secrets, before saving or sending it", async () => {
    const { w, client } = await signedIn();
    const saveBackup = vi.fn(async () => {});
    const requests = w.requests.length;
    for (const [label, stateJson, message] of edits(generated.stateJson)) {
      const error = await client.vaults.create({ name: "bad state", passphrase, saveBackup, stateJson }).then(
        () => new Error(`${label} was accepted`),
        (e: Error) => e,
      );
      expect(error, label).toBeInstanceOf(RefusedState);
      const reason = /^The supplied recovery state was refused: (.+)\. Nothing was saved or registered\.$/.exec(error.message);
      expect(reason?.[1], `${label}: ${error.message}`).toMatch(message);
    }
    expect(saveBackup).not.toHaveBeenCalled();
    // Each attempt only read the deployment's configuration and this address's vaults.
    expect(new Set(w.requests.slice(requests).map((r) => `${r.method} ${new URL(r.url).pathname}`))).toEqual(
      new Set(["GET /v1/config", "GET /v1/vaults"]),
    );
    expect(vaultPosts(w)).toHaveLength(0);
  }, 120000);

  it("reports a runtime failure as that, not as a refused state", async () => {
    const { w, client } = await signedIn();
    const saveBackup = vi.fn(async () => {});
    for (const [bridge, message] of [
      ["altered", /^QSB source integrity check failed$/],
      ["failing", /^setup failed$/],
    ] as const) {
      damaged.bridge = bridge;
      try {
        const error = await client.vaults.create({ name: "damaged", passphrase, saveBackup, stateJson: generated.stateJson }).then(
          () => new Error(`${bridge} was accepted`),
          (e: Error) => e,
        );
        expect(error, bridge).not.toBeInstanceOf(RefusedState);
        expect(error.message, bridge).toMatch(message);
      } finally {
        damaged.bridge = undefined;
      }
    }
    expect(saveBackup).not.toHaveBeenCalled();
    expect(vaultPosts(w)).toHaveLength(0);
  }, 120000);

  it("refuses a state that reuses any HORS secret of a vault of this address", async () => {
    const { w, client } = await signedIn();
    const saveBackup = vi.fn(async () => {});
    const { vault } = await client.vaults.create({ name: "first", passphrase, saveBackup, stateJson: generated.stateJson });
    // The same state, and a valid new one that shares a single secret, in another position.
    const first = JSON.parse(generated.stateJson).hors_secrets as string[][];
    const { stateJson: overlapping } = await generatedFrom([...Array.from({ length: 299 }, () => hex.encode(randomBytes(20))), first[0][42]]);
    for (const stateJson of [generated.stateJson, overlapping])
      await expect(client.vaults.create({ name: "second", passphrase, saveBackup, stateJson })).rejects.toThrow(
        new RefusedState(
          `This recovery state reuses HORS secrets of vault ${vault.id}. A state's secrets lock one vault, which takes one deposit; nothing was saved or registered.`,
        ),
      );
    expect(saveBackup).toHaveBeenCalledOnce();
    expect(vaultPosts(w)).toHaveLength(1);
  }, 120000);

  it("finds the secrets in the script of a vault another client registered, whatever commitments it declares", async () => {
    const first = JSON.parse(generated.stateJson).hors_secrets as string[][];
    const overlapping = await generatedFrom([first[1][7], ...Array.from({ length: 299 }, () => hex.encode(randomBytes(20)))]);
    const commitments = (data: Generated, edit: (c: string) => string) => ({
      ...data,
      publicStateJson: data.publicStateJson.replace(/"([0-9a-f]{40})"/g, (_, c: string) => `"${edit(c)}"`),
    });
    // The server checks a vault's script, not the commitments its public state declares.
    const unrelated = () => hex.encode(randomBytes(20));
    for (const [label, registered] of [
      ["another script sharing one secret", commitments(overlapping, unrelated)],
      ["the same script", commitments(generated, unrelated)],
    ] as const) {
      const { w, signer, client } = await signedIn();
      const other = new QsbClient({ baseUrl: API, signer, fetch: w.fetch, token: client.token, qsb: { ...nodeQsb(), generateQsb: async () => registered } });
      const { vault } = await other.vaults.create({ name: "other client", passphrase, saveBackup: async () => {} });
      expect(vault.publicStateJson, label).toBe(registered.publicStateJson);
      const saveBackup = vi.fn(async () => {});
      await expect(client.vaults.create({ name: "mine", passphrase, saveBackup, stateJson: generated.stateJson }), label).rejects.toThrow(
        `This recovery state reuses HORS secrets of vault ${vault.id}.`,
      );
      expect(saveBackup, label).not.toHaveBeenCalled();
    }
  }, 120000);

  it("refuses to register when the same secrets were registered while its backup was saved", async () => {
    const { w, signer, client } = await signedIn();
    const other = new QsbClient({ baseUrl: API, signer, fetch: w.fetch, token: client.token });
    let registered = "";
    const saveBackup = vi.fn(async () => {
      ({ vault: { id: registered } } = await other.vaults.create({ name: "meanwhile", passphrase, saveBackup: async () => {}, stateJson: generated.stateJson }));
    });
    await expect(client.vaults.create({ name: "slow save", passphrase, saveBackup, stateJson: generated.stateJson })).rejects.toThrow(
      /^This recovery state reuses HORS secrets of vault [0-9a-f-]{36}, registered while its backup was saved\. Nothing was registered/,
    );
    expect(saveBackup).toHaveBeenCalledOnce();
    expect(vaultPosts(w).map((r) => JSON.parse(r.body).id)).toEqual([registered]);
  }, 120000);

  const storedVaults = (w: ReturnType<typeof world>) =>
    [...w.store.rows.values()].filter((row) => row.sk.startsWith("VAULT#")).map((row) => (row.vault as { id: string }).id);

  it("reports the server's refusal of a script another address registered as a refused state", async () => {
    const { w, client } = await signedIn();
    const someone = wallet(w.chain);
    const theirs = new QsbClient({ baseUrl: API, signer: loopbackTestSigner(someone.wif, API), fetch: w.fetch, qsb: replacedRuntime() });
    await theirs.login();
    const { vault } = await theirs.vaults.create({ name: "theirs", passphrase, saveBackup: async () => {}, stateJson: generated.stateJson });
    // This address has no vault, so only the server can see that the script is taken.
    const saveBackup = vi.fn(async () => {});
    const error = await client.vaults.create({ name: "mine", passphrase, saveBackup, stateJson: generated.stateJson }).then(
      () => new Error("registered"),
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(RefusedState);
    expect(error.message).toBe(
      "The deployment refused to register the vault (vault_script_registered): another vault on this deployment already has this script. A script locks one vault, which takes one deposit. Nothing was registered, and the backup just saved is for no new vault: pay into this script only as the one deposit of the vault that has it. Destroy that backup only if you hold another copy of this state.",
    );
    expect(saveBackup).toHaveBeenCalledOnce();
    expect(storedVaults(w)).toEqual([vault.id]);
  }, 120000);

  it("reports the server's refusal of a script already paid on chain as a refused state", async () => {
    const { w, client } = await signedIn();
    const payment = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
    payment.addInput({ txid: randomBytes(32), index: 0 });
    payment.addOutput({ script: hex.decode(generated.scriptHex), amount: 10_000n });
    w.chain.add(hex.encode(payment.toBytes(true, false)));
    const error = await client.vaults.create({ name: "paid", passphrase, saveBackup: async () => {}, stateJson: generated.stateJson }).then(
      () => new Error("registered"),
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(RefusedState);
    // The secrets may already lock someone's payment: the message never says to discard the backup.
    expect(error.message).toBe(
      "The deployment refused to register the vault (vault_script_paid): something has already paid this script on chain. A script locks one vault, which takes one deposit, so no new vault can have it. Nothing was registered. Keep the backup just saved, or another copy of this state: it holds the secrets that can spend what was paid. Don't pay into this script for a new vault.",
    );
    expect(storedVaults(w)).toEqual([]);
  }, 120000);

  it("says a failed chain lookup registered nothing, and that the same state can be tried again", async () => {
    const { w, client } = await signedIn();
    w.chain.failing.add("/scripthash/");
    const saveBackup = vi.fn(async () => {});
    const error = await client.vaults.create({ name: "chain down", passphrase, saveBackup, stateJson: generated.stateJson }).then(
      () => new Error("registered"),
      (e: Error) => e,
    );
    // Not a verdict on the state.
    expect(error).not.toBeInstanceOf(RefusedState);
    expect(error.message).toBe(
      "The deployment couldn't check the vault's script on chain (chain_unavailable), so it registered nothing. The backup just saved is for an unregistered vault: never pay into its script. Retry with the same state.",
    );
    expect(saveBackup).toHaveBeenCalledOnce();
    expect(storedVaults(w)).toEqual([]);
    w.chain.failing.clear();
    const { vault } = await client.vaults.create({ name: "chain back", passphrase, saveBackup, stateJson: generated.stateJson });
    expect(storedVaults(w)).toEqual([vault.id]);
  }, 120000);
});

describe("qsb vault create --state", () => {
  it("creates the vault from a state file, and refuses one that doesn't match or is also the backup", async () => {
    const w = world();
    const owner = wallet(w.chain);
    const cwd = mkdtempSync(path.join(tmpdir(), "qsb-cli-"));
    writeFileSync(path.join(cwd, "state.json"), generated.stateJson);
    const [, tampered] = edits(generated.stateJson)[0];
    writeFileSync(path.join(cwd, "tampered.json"), tampered);
    async function qsb(...argv: string[]) {
      const stdout = new PassThrough(), stderr = new PassThrough();
      let out = "", err = "";
      stdout.on("data", (chunk) => (out += chunk));
      stderr.on("data", (chunk) => (err += chunk));
      const env = { QSB_API_URL: API, QSB_HOME: path.join(cwd, "home"), QSB_PASSPHRASE: passphrase, QSB_TEST_SIGNER_KEY: owner.wif };
      const code = await runCli(["--signer", "test-key", ...argv], { env, stdin: Readable.from([]), stdout, stderr, interactive: false, cwd, fetch: w.fetch });
      return { code, out, err };
    }
    const reused = await qsb("vault", "create", "--name", "cli", "--backup", "state.json", "--state", "state.json");
    expect(reused.code).toBe(2);
    expect(reused.err).toContain("state.json is used twice");
    const refused = await qsb("vault", "create", "--name", "cli", "--backup", "refused.json", "--state", "tampered.json");
    expect(refused.code, refused.err).toBe(1);
    expect(refused.err).toContain("The supplied recovery state was refused: hors_commitments[0][17] is not what the pipeline builds");
    expect(existsSync(path.join(cwd, "refused.json"))).toBe(false);
    expect(vaultPosts(w)).toHaveLength(0);

    const created = await qsb("vault", "create", "--name", "cli", "--backup", "vault.json", "--state", "state.json");
    expect(created.code, created.err).toBe(0);
    expect(created.err).toContain("state.json still holds the recovery state unencrypted");
    const { vault } = JSON.parse(created.out);
    expect(vault.scriptHash).toBe(generated.scriptHash);
    expect((await decryptRecovery(readFileSync(path.join(cwd, "vault.json"), "utf8"), passphrase)).stateJson).toBe(generated.stateJson);
  }, 120000);
});
