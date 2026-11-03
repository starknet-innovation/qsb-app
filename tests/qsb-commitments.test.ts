import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { hmac } from "@noble/hashes/hmac.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { loadPyodide } from "pyodide";
import { startQsbRuntime, type QsbMethod } from "../src/lib/qsb-runtime";
import { commitmentOperations, type PreparedAssembly } from "../src/lib/qsb-operations";
import { nodeQsb } from "../sdk/runtime";

/**
 * The commitments-only bridge entries (bridge.py: setup_from_commitments, prepare, finish).
 *
 * The secrets are the BIP draft "QSB Wallet Secret Management" (QSB-HORS-v1) test vault: its
 * published test key K = 00 01 .. 1f, network 0, vault 0. They are public test values that hold
 * no funds. A real Config A hit needs a GPU search, and no solved hit for secrets this repository
 * may hold exists, so the byte-for-byte checks of prepare and finish against assemble replace the
 * pipeline's puzzle check (puzzle_hash) with one that accepts every candidate. Everything else in
 * the pipeline's assemble runs as it is, for assemble and for prepare and finish alike.
 */
const K = Uint8Array.from({ length: 32 }, (_, i) => i);
function secret(r: number, i: number) {
  const m = new Uint8Array(20);
  m.set(new TextEncoder().encode("QSB-HORS-v1"));
  m.set([0, 0, 0, 0, 0, 0, r, i >> 8, i & 0xff], 11);
  return hmac(sha256, K, m).slice(0, 20);
}
const secrets = [0, 1].map((r) => Array.from({ length: 150 }, (_, i) => secret(r, i)));
const commitments = secrets.map((round) => round.map((s) => hex.encode(ripemd160(sha256(s)))));
const secretHex = secrets.map((round) => round.map((s) => hex.encode(s)));

const manifest = {
  vaultId: "00000000-0000-4000-8000-000000000000",
  // Not palindromes, so a txid in the wrong byte order shows.
  funding: { txid: `a0${"11".repeat(31)}`, vout: 0, value: "100000" },
  helper: { txid: `b0${"22".repeat(31)}`, vout: 1, value: "20000" },
  destination: "bc1qxyz",
  outputScript: `0014${"33".repeat(20)}`,
  outputValue: "110000",
  fee: "10000",
};
// Unsorted, like a solver's output: the pipeline sorts each subset and signs with its first 8 and 7.
const solution = {
  sequence: 2147483648,
  locktime: 500000000,
  round1: [140, 3, 77, 12, 9, 0, 149, 45, 60],
  round2: [5, 100, 4, 99, 33, 22, 11, 148, 2],
};
const ascending = (values: number[]) => [...values].sort((a, b) => a - b);

type Runtime = Awaited<ReturnType<typeof startQsbRuntime>> & { py: any };
async function bridgeRuntime(acceptEveryPuzzle: boolean): Promise<Runtime> {
  const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
  const runtime = await startQsbRuntime(py, async (file) =>
    new Uint8Array(await readFile(new URL(`../public/qsb/${file}`, import.meta.url))),
  );
  if (acceptEveryPuzzle)
    py.runPython(
      "import qsb_pipeline, secp256k1\n" +
        "_sig = secp256k1.encode_der_sig(secp256k1.G[0], 1, sighash=0x01)\n" +
        "qsb_pipeline.puzzle_hash = lambda pubkey, hash_mode='ripemd160', hash_choice=0: (_sig, True, 0)",
    );
  return { ...runtime, py };
}
/** What setup and result build from the test secrets: what generate returns for them. */
function generated(runtime: Runtime) {
  runtime.py.globals.set("secrets", JSON.stringify(secretHex.flat()));
  return JSON.parse(
    runtime.py.runPython("import bridge, json\nbridge.result(bridge.setup([bytes.fromhex(s) for s in json.loads(secrets)]))"),
  ) as { stateJson: string; publicStateJson: string; scriptHex: string; scriptHash: string };
}
/** The bridge's refusal message for a call, as the SDK reports it; undefined if the call returned. */
function refusal(runtime: Runtime, method: QsbMethod, args: string[]) {
  try {
    runtime.call(method, args);
  } catch (error) {
    const lines = (error as Error).message.trim().split("\n");
    return lines[lines.length - 1]!.replace(/^ValueError: /, "");
  }
}
/** The public state JSON text after a Python edit of `state`: JSON.parse would round its big integers. */
function edited(runtime: Runtime, text: string, edit: string): string {
  runtime.py.globals.set("text", text);
  return runtime.py.runPython(`import json\nstate = json.loads(text)\n${edit}\njson.dumps(state)`);
}
const ops = (runtime: Runtime) => commitmentOperations(async (method, args = []) => runtime.call(method, args));
const selected = (prepared: PreparedAssembly) => [
  ...prepared.round0.map((i) => secretHex[0]![i]!),
  ...prepared.round1.map((i) => secretHex[1]![i]!),
];

describe("the test secrets", () => {
  it("are the BIP draft's QSB-HORS-v1 vault 0 for its test key", () => {
    // Test vectors from the BIP draft; the root binds the commitments in the bridge's round and index order.
    expect(secretHex[0]![0]).toBe("df83cf4950602d2d3b90041023b941271bc7c494");
    expect(commitments[0]![0]).toBe("887b040fb41eb3cf514e3bd63986f08697b943c4");
    expect(secretHex[1]![149]).toBe("84f94456b5537fc0a7b922e056673e455d666c0a");
    const root = sha256(new Uint8Array([...new TextEncoder().encode("QSB-HORS-v1/root"), ...hex.decode(commitments.flat().join(""))]));
    expect(hex.encode(root)).toBe("9b257b6acd00017b1488ed9d73d05bc8a5dbdd43c8aa54d1d37c7e807d65c515");
  });
});

describe("setup_from_commitments", () => {
  let runtime: Runtime;
  beforeAll(async () => {
    runtime = await bridgeRuntime(false);
  }, 60000);

  it("returns what generate returns for the secrets, less the state, from their commitments alone", async () => {
    const full = generated(runtime);
    const qsb = nodeQsb();
    try {
      const fromCommitments = await qsb.setupFromCommitments(commitments);
      expect(JSON.stringify(fromCommitments)).toBe(
        JSON.stringify({ publicStateJson: full.publicStateJson, scriptHex: full.scriptHex, scriptHash: full.scriptHash }),
      );
      for (const s of secretHex.flat()) expect(JSON.stringify(fromCommitments)).not.toContain(s);
    } finally {
      qsb.lockQsb();
    }
  }, 120000);

  it("refuses anything but 2 rounds of 150 distinct commitments in lowercase hex", () => {
    const replaced = (r: number, i: number, value: unknown) =>
      JSON.stringify(commitments.map((round, ri) => round.map((c, ci) => (ri === r && ci === i ? value : c))));
    const cases: [string, string][] = [
      [JSON.stringify([[[commitments[0]]], commitments[1]]), "the commitment list nests deeper than 2 rounds of commitments"],
      ['{"a":1,"a":2}', "a appears twice in one object"],
      [JSON.stringify([commitments[0]]), "the commitments are not 2 rounds of 150"],
      [JSON.stringify([commitments[0], commitments[1]!.slice(1)]), "the commitments are not 2 rounds of 150"],
      [JSON.stringify(commitments.flat()), "the commitments are not 2 rounds of 150"],
      [replaced(1, 3, commitments[1]![3]!.toUpperCase()), "a commitment is not 20 bytes of lowercase hex"],
      [replaced(0, 7, commitments[0]![7]!.slice(2)), "a commitment is not 20 bytes of lowercase hex"],
      [replaced(0, 7, 7), "a commitment is not 20 bytes of lowercase hex"],
      [replaced(1, 0, commitments[0]![0]), "a commitment repeats"],
    ];
    expect(refusal(runtime, "setup_from_commitments", ["[["])).toMatch(/^the commitment list is not JSON this check reads \(/);
    for (const [text, message] of cases) expect(refusal(runtime, "setup_from_commitments", [text])).toBe(message);
    expect(() => runtime.call("setup_from_commitments", [undefined as unknown as string])).toThrow(
      /the commitment list is not JSON text/,
    );
  }, 60000);
});

describe("prepare and finish", () => {
  let runtime: Runtime;
  let full: ReturnType<typeof generated>;
  let raw: string;
  let prepared: PreparedAssembly;
  beforeAll(async () => {
    runtime = await bridgeRuntime(true);
    full = generated(runtime);
    raw = runtime.call("assemble", [full.stateJson, JSON.stringify(manifest), JSON.stringify(solution)]);
    prepared = await ops(runtime).prepareAssembly(full.publicStateJson, manifest, solution);
  }, 300000);

  it("prepare returns T and the indices to disclose, in the pipeline's order, and no secret", () => {
    expect(prepared.round0).toEqual(ascending(solution.round1).slice(0, 8));
    expect(prepared.round1).toEqual(ascending(solution.round2).slice(0, 7));
    const opts = { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true };
    const assembled = btc.Transaction.fromRaw(hex.decode(raw), opts);
    // T: assemble's transaction with every scriptSig empty and no witness.
    expect(prepared.transaction).toBe(hex.encode(assembled.unsignedTx));
    const t = btc.Transaction.fromRaw(hex.decode(prepared.transaction), opts);
    expect([t.version, t.lockTime, t.inputsLength, t.outputsLength]).toEqual([1, solution.locktime, 2, 1]);
    expect([0, 1].map((n) => [hex.encode(t.getInput(n).txid!), t.getInput(n).index, t.getInput(n).sequence])).toEqual([
      [manifest.helper.txid, manifest.helper.vout, 0xfffffffe],
      [manifest.funding.txid, manifest.funding.vout, solution.sequence],
    ]);
    expect([hex.encode(t.getOutput(0).script!), t.getOutput(0).amount]).toEqual([manifest.outputScript, 110000n]);
    expect([prepared.scriptHash, prepared.publicStateJson]).toEqual([full.scriptHash, full.publicStateJson]);
    expect([prepared.manifest, prepared.solution]).toEqual([manifest, solution]);
    for (const s of secretHex.flat()) expect(JSON.stringify(prepared)).not.toContain(s);
  });

  it("finish with exactly the 15 selected preimages returns assemble's transaction, byte for byte", async () => {
    expect(await ops(runtime).finishAssembly(prepared, selected(prepared))).toBe(raw);
  }, 120000);

  it("finish refuses any other preimages, in number, order or value", () => {
    const preimages = selected(prepared);
    const bonus = ascending(solution.round1)[8]!;
    const cases: [unknown, string][] = [
      [preimages.slice(0, 14), "the preimages are not a list of exactly 15"],
      [[...preimages, secretHex[0]![bonus]], "the preimages are not a list of exactly 15"],
      // The whole secret set, as rounds or flat.
      [secretHex, "the preimage list nests deeper than a list of preimages"],
      [secretHex.flat(), "the preimages are not a list of exactly 15"],
      [[...preimages.slice(8), ...preimages.slice(0, 8)], `preimage 0 is not the preimage of round0 index ${prepared.round0[0]}'s commitment`],
      [[preimages[1], preimages[0], ...preimages.slice(2)], `preimage 0 is not the preimage of round0 index ${prepared.round0[0]}'s commitment`],
      [[...preimages.slice(0, 7), secretHex[0]![bonus], ...preimages.slice(8)], `preimage 7 is not the preimage of round0 index ${prepared.round0[7]}'s commitment`],
      [[preimages[0]!.toUpperCase(), ...preimages.slice(1)], "a preimage is not 20 bytes of lowercase hex"],
    ];
    for (const [value, message] of cases)
      expect(refusal(runtime, "finish", [JSON.stringify(prepared), JSON.stringify(value)])).toBe(message);
    expect(refusal(runtime, "finish", [JSON.stringify(prepared), "[1"])).toMatch(/^the preimage list is not JSON this check reads \(/);
  }, 120000);

  it("finish refuses a prepared withdrawal that isn't what prepare returned", () => {
    const preimages = selected(prepared);
    const bonus = ascending(solution.round1)[8]!;
    const swapped = [prepared.round0[1]!, prepared.round0[0]!, ...prepared.round0.slice(2)];
    const at = (n: number) => (n < 8 ? secretHex[0]![swapped[n]!]! : preimages[n]!);
    const otherLocktime = prepared.transaction.slice(0, -8) + "00000000";
    const withSecrets = edited(runtime, full.publicStateJson, `state['hors_secrets'] = ${JSON.stringify(secretHex)}`);
    const cases: [object, string[], string][] = [
      // Each preimage matches its index, but the pipeline signs round0's first two the other way round.
      [{ ...prepared, round0: swapped }, Array.from({ length: 15 }, (_, n) => at(n)), "the solution does not sign with these preimages in this order"],
      // A disclosed bonus index in place of a signed one: the pipeline needs the secret it left out.
      [
        { ...prepared, round0: [...prepared.round0.slice(0, 7), bonus] },
        [...preimages.slice(0, 7), secretHex[0]![bonus]!, ...preimages.slice(8)],
        "the solution signs with a secret round0 and round1 do not disclose",
      ],
      [{ ...prepared, transaction: otherLocktime }, preimages, "the assembled transaction is not prepare's transaction"],
      [{ ...prepared, manifest: { ...manifest, outputValue: "109999" } }, preimages, "the assembled transaction is not prepare's transaction"],
      [{ ...prepared, solution: { ...solution, locktime: solution.locktime + 1 } }, preimages, "the assembled transaction is not prepare's transaction"],
      [{ ...prepared, scriptHash: "00".repeat(32) }, preimages, "scriptHash is not the vault script's SHA-256"],
      [{ ...prepared, publicStateJson: withSecrets }, preimages, "hors_secrets is not a field of the public state"],
      [{ ...prepared, round1: prepared.round1.slice(1) }, preimages, "round0 and round1 are not 8 and 7 distinct indices below 150"],
      [{ ...prepared, transaction: prepared.transaction.toUpperCase() }, preimages, "transaction is not lowercase hex"],
      [{ ...prepared, extra: 1 }, preimages, "extra is not a field prepare returns"],
      [(({ scriptHash: _, ...rest }) => rest)(prepared), preimages, "scriptHash is missing"],
    ];
    for (const [value, values, message] of cases)
      expect(refusal(runtime, "finish", [JSON.stringify(value), JSON.stringify(values)])).toBe(message);
    const twice = JSON.stringify(prepared).replace('"round1":', `"round0":${JSON.stringify(prepared.round0)},"round1":`);
    expect(refusal(runtime, "finish", [twice, JSON.stringify(preimages)])).toBe("round0 appears twice in one object");
  }, 300000);
});

describe("prepare's refusals", () => {
  let runtime: Runtime;
  let full: ReturnType<typeof generated>;
  beforeAll(async () => {
    runtime = await bridgeRuntime(false);
    full = generated(runtime);
  }, 120000);
  const prepare = (state: unknown, m: unknown = manifest, hit: unknown = solution) =>
    refusal(runtime, "prepare", [typeof state === "string" ? state : JSON.stringify(state), JSON.stringify(m), JSON.stringify(hit)]);

  it("refuses a solution the pipeline can't assemble, before anything could be disclosed", () => {
    expect(prepare(full.publicStateJson)).toBe("QSB solution failed local assembly");
    // It leaves the pipeline as it found it: setup draws from the system's random source again.
    expect(
      runtime.py.runPython(
        "import os, posix, bitcoin_tx, qsb_pipeline\n" +
          "[os.urandom is posix.urandom, qsb_pipeline.QSBScriptBuilder is bitcoin_tx.QSBScriptBuilder, qsb_pipeline.p2pkh_script.__name__]",
      ).toJs(),
    ).toEqual([true, true, "p2pkh_script"]);
  }, 120000);

  it("refuses a state that isn't exactly the public state of its commitments", () => {
    const edit = (change: string) => edited(runtime, full.publicStateJson, change);
    const cases: [unknown, string][] = [
      [full.stateJson, "hors_secrets is not a field of the public state"],
      [edit("state['round_sigs'][0]['k'] = 1"), "round_sigs[0].k is not a field of the public state"],
      [edit("state['pin_s'] += 1"), "pin_s is not what the pipeline builds from these commitments"],
      [edit("state['full_script_hex'] += '51'"), "full_script_hex is not what the pipeline builds from these commitments"],
      [edit("del state['dummy_sigs']"), "dummy_sigs is missing"],
      [edit("del state['hors_commitments']"), "hors_commitments is missing"],
      [edit("state = list(state)"), "the public state is not a JSON object"],
    ];
    for (const [state, message] of cases) expect(prepare(state)).toBe(message);
  }, 120000);

  it("refuses a manifest or solution that can't make the transaction", () => {
    const m = manifest;
    const cases: [unknown, unknown, string][] = [
      [{ ...m, funding: { ...m.funding, txid: m.funding.txid.slice(2) } }, solution, "funding.txid is not a transaction id"],
      [{ ...m, helper: { ...m.helper, vout: -1 } }, solution, "helper.vout is not an output index"],
      [{ ...m, helper: { ...m.funding, txid: m.funding.txid.toUpperCase() } }, solution, "the helper outpoint is the vault outpoint"],
      [{ ...m, funding: { ...m.funding, value: "1e5" } }, solution, "funding.value is not an amount of satoshis"],
      [{ ...m, outputValue: "2100000000000001" }, solution, "outputValue is not an amount of satoshis"],
      [{ ...m, outputScript: "0014zz" }, solution, "outputScript is not a script in hex"],
      [Object.keys(m), solution, "the manifest is not a JSON object"],
      [m, { ...solution, sequence: -1 }, "sequence is not a 32-bit unsigned integer"],
      [m, { ...solution, locktime: 2 ** 32 }, "locktime is not a 32-bit unsigned integer"],
      [m, { ...solution, round1: solution.round1.slice(1) }, "round1 is not 9 distinct indices below 150"],
      [m, { ...solution, round1: [...solution.round1.slice(1), solution.round1[1]] }, "round1 is not 9 distinct indices below 150"],
      [m, { ...solution, round2: [...solution.round2.slice(1), 150] }, "round2 is not 9 distinct indices below 150"],
      [m, { ...solution, round2: [...solution.round2.slice(1), true] }, "round2 is not 9 distinct indices below 150"],
    ];
    for (const [value, hit, message] of cases) expect(prepare(full.publicStateJson, value, hit)).toBe(message);
  }, 60000);
});
