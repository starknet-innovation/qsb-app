import { beforeAll, describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import vectors from "../contracts/pqb-ranked-v2.json";
import reference from "./fixtures/pqb-reference.json";
import { adoptPqb, assemblePqb, pqbPacket, pqbProblem, pqbPublicStateSchema, PQB_MAX_SCRIPTSIG } from "../src/lib/pqb";
import { solutionSchema } from "../src/lib/solution";
import { withdrawalSchema } from "../src/lib/model";
import { pqbWorkRange } from "../server/pqb-search";
import { pqbReference } from "../server/pqb-reference";
import { comb, evaluate, parseStrictDer, solves } from "../src/pqb-core/grind";
import { pinFields } from "../src/pqb-core/spend";
import { buildLock } from "../src/pqb-core/lock";
import { assemble } from "../src/pqb-core/spend";
import { pqbTransaction } from "../src/lib/pqb";
import { fromHex, hex, toInt } from "../src/pqb-core/primitives";
import { legacySighashAll, parseScript } from "../src/pqb-core/tx";

let generated: ReturnType<typeof adoptPqb>;
const manifest = withdrawalSchema.parse(reference.manifest);
const [locktime, sequence] = pinFields(BigInt(reference.pinNonce));
const prior = { locktime, sequence, round1: reference.priorSelection, round2: [] };
beforeAll(() => { generated = adoptPqb(JSON.stringify({ config: "PQB", seed: reference.seed })); });

describe("PQB generator and independent Python reference", () => {
  it("rebuilds the exact real-puzzle script from the public synthetic reference seed", () => {
    expect(generated.scriptHex).toBe(reference.scriptHex);
    expect(generated.scriptHex.length / 2).toBe(4908);
    expect(pqbPublicStateSchema.parse(JSON.parse(generated.publicStateJson)).config).toBe("PQB");
    expect(generated.publicStateJson).not.toContain(reference.seed);
    for (const field of ["seed", "s", "sigs", "preimages", "cosig", "privateKey"])
      expect(generated.publicStateJson).not.toContain(`"${field}":`);
    expect(() => adoptPqb(JSON.stringify({ config: "PQB", seed: reference.seed, unknown: "secret" }))).toThrow();
    expect(() => pqbPublicStateSchema.parse({ ...JSON.parse(generated.publicStateJson), seed: reference.seed })).toThrow();
  });

  it("matches Python's problem bytes and canonical sighash/digest trials for all three two-input stages", () => {
    for (const [stage, fixture] of reference.stages.entries()) {
      expect(pqbProblem(generated.publicStateJson, manifest, stage, prior)).toBe(fixture.problem);
      const packet = pqbPacket(generated.publicStateJson, manifest, stage, prior);
      for (const trial of fixture.trials) {
        const got = evaluate(packet, BigInt(trial.nonce), trial.variant, trial.menuIndex, trial.encoding, 0);
        expect(hex(got.digest!)).toBe(trial.digest);
        expect(got.z.toString()).toBe(trial.z);
      }
    }
  });

  it("binds every public problem to the exact inputs, output, amount and fee", () => {
    const base = pqbProblem(generated.publicStateJson, manifest, 0);
    for (const altered of [
      { ...manifest, helper: { ...manifest.helper, vout: 2 } },
      { ...manifest, funding: { ...manifest.funding, txid: "44".repeat(32) } },
      { ...manifest, outputScript: "0014" + "55".repeat(20) },
      { ...manifest, outputValue: "108000", fee: "2000" },
    ]) expect(pqbProblem(generated.publicStateJson, altered, 0)).not.toBe(base);
    expect(() => pqbProblem(generated.publicStateJson, { ...manifest, fee: "2000" }, 0)).toThrow();
    expect(() => pqbPacket(generated.publicStateJson, manifest, 2, { ...prior, round1: Array(8).fill(1) })).toThrow();
    const packet = pqbPacket(generated.publicStateJson, manifest, 2, prior);
    expect(packet.live_slots).toHaveLength(101);
    expect(packet.live_slots!.some(i => prior.round1.includes(i))).toBe(false);
  });

  it("exports only the worker's public problem fields and refuses false or partial candidates", () => {
    const base = { action: "export", publicStateJson: generated.publicStateJson, manifest, stage: "pinning" };
    expect(Object.keys(pqbReference(base)).sort()).toEqual(["problemBase64", "problemSha256"]);
    expect(() => pqbReference({ ...base, seed: reference.seed })).toThrow();
    expect(() => pqbReference({ ...base, action: "verify", candidates: ["2147483648 500000000 0 0 0 1"] })).toThrow("CPU verification");
    expect(pqbReference({ ...base, action: "verify", candidates: [] })).toEqual({ valid: false, derOnly: true });
    expect(() => assemblePqb(generated.stateJson, manifest, { ...prior, pqb: { pinning: "2147483648 500000000 0 0 0 1" } })).toThrow("Incomplete");
  });

  it("checks full strict DER and rejects SIGHASH_SINGLE even after the 24-bit gate", () => {
    // Constructed signature encodings, not solutions to a hash puzzle.
    const d = new Uint8Array(32).fill(1);
    d.set([0x30, 0x1d, 2, 12]); d[16] = 2; d[17] = 13; d[31] = 1;
    expect(parseStrictDer(d)).not.toBeNull();
    const packet = pqbPacket(generated.publicStateJson, manifest, 0);
    expect(solves(packet, d, 1n)).toBe(true);
    d[31] = 3;
    expect(solves(packet, d, 1n)).toBe(false);
    d[3] = 0;
    expect(solves(packet, d, 1n)).toBe(false);
  });

  it("constructs the two-input witness with a real SIGHASH_ALL co-signature within the fee bound", () => {
    // Witness assembly only: these default subsets do not solve the real hash puzzles.
    const lock = buildLock("PQB", fromHex(reference.seed));
    const tx = pqbTransaction(manifest, sequence, locktime);
    const out = assemble(lock, { txid: manifest.funding.txid, vout: 0, amount: 100000 }, [], {
      transaction: tx, inputIndex: 1, selection: [reference.priorSelection, [0, 1, 2, 4, 5, 6, 7, 8, 10]],
    });
    expect(out.simError).toBeNull();
    expect(out.scriptSig.length).toBeLessThanOrEqual(PQB_MAX_SCRIPTSIG);
    expect(out.tx.vin[0].scriptSig.length).toBe(0);
    expect(out.tx.vin[1].scriptSig).toEqual(out.scriptSig);
    expect(out.zCosig).toBe(toInt(legacySighashAll(out.tx, 1, lock.script)));
    const pushes = parseScript(out.scriptSig), sig = pushes.at(-2)![2]!, pk = pushes.at(-1)![2]!;
    expect(sig.at(-1)).toBe(1);
    expect(secp256k1.verify(sig.subarray(0, -1), legacySighashAll(out.tx, 1, lock.script), pk,
      { format: "der", prehash: false, lowS: true })).toBe(true);
  });
});

describe("pqb-ranked-v2 partition", () => {
  const appStage = (s: string) => s === "round0" ? "round1" : s === "round1" ? "round2" : s === "pinning" ? s : "unsupported";
  it("matches every published valid solver vector", () => {
    for (const v of vectors.cases) expect(pqbWorkRange(appStage(v.stage), v.attempt)).toEqual(v.range);
    for (const v of vectors.invalid) {
      // JSON.parse turns Python's 1.0 into JS's integer 1; JS emits it as 1 on the worker wire.
      if (v.stage === "round1" && v.attempt === 1) continue;
      expect(() => pqbWorkRange(appStage(v.stage), v.attempt as number)).toThrow();
    }
    expect(JSON.stringify({ attempt: 1.0 })).toBe('{"attempt":1}');
  });
  it("covers every round subset exactly once, including each short final unit", () => {
    for (const [stage, n, t, count] of [["round1", 109, 8, 70], ["round2", 101, 9, 174]] as const) {
      let end = 0n;
      for (let attempt = 0; attempt < count; attempt++) {
        const unit = pqbWorkRange(stage, attempt);
        expect(BigInt(unit.start)).toBe(end); end += BigInt(unit.count);
      }
      expect(end).toBe(comb(n, t));
      expect(() => pqbWorkRange(stage, count)).toThrow("exhausted");
    }
    const last = pqbWorkRange("pinning", 153391688);
    expect(last.sequence! + last.sequenceCount! - 1).toBe(0xfffffffd);
    expect(BigInt(last.start) + BigInt(last.count)).toBe(BigInt(vectors.shapes.pinning.sequenceCount) * 1200000000n);
  });
});
