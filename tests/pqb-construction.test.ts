// PQB constructions: v0 (the pre-version eccdd09 vaults) and v1 (upstream 82c7cba, which the PQB
// Ledger app builds). Public synthetic fixtures from each commit's independent Python reference.
import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import v0 from "./fixtures/pqb-reference.json";
import v1 from "./fixtures/pqb-reference-v1.json";
import configs from "../src/pqb-core/configs.json";
import provenance from "../src/pqb-core/provenance.json";
import { buildLock, LATEST_VERSION, VERSIONS } from "../src/pqb-core/lock";
import { assemble, pinFields } from "../src/pqb-core/spend";
import { evaluate } from "../src/pqb-core/grind";
import { fromHex, hex } from "../src/pqb-core/primitives";
import { legacySighashAll, parseScript } from "../src/pqb-core/tx";
import {
  adoptPqb, generatePqb, pqbSharesSecrets, pqbPacket, pqbProblem, pqbTransaction, validatePqbPublicState, PQB_MAX_SCRIPTSIG,
} from "../src/lib/pqb";
import { withdrawalSchema } from "../src/lib/model";
import { solverServesVault, vaultConfiguration, withVaultConfiguration } from "../src/lib/provenance";
import { PQB_CONSTRUCTION_COMMITS, pqbConstructionOf } from "../src/lib/pqb-identity";
import pqbV020 from "../src/lib/releases/qsb-solver-pqb-aws-sm86-v0-2-0.json";
import { servedFixture } from "./solver-fixture";

const state = (seed: string, version?: string) =>
  JSON.stringify({ config: "PQB", seed, ...(version ? { version } : {}) });
const vaultOf = (g: ReturnType<typeof adoptPqb>) => ({ network: "mainnet", config: "PQB",
  scriptHex: g.scriptHex, scriptHash: g.scriptHash, publicStateJson: g.publicStateJson });

describe("vendored constructions", () => {
  it("vendors upstream 82c7cba with v1 latest and v0 kept as eccdd09's parameters", () => {
    expect(VERSIONS).toEqual(Object.keys(provenance.constructions));
    expect(LATEST_VERSION).toBe("v1");
    expect(PQB_CONSTRUCTION_COMMITS).toEqual({ v0: v0.commit, v1: v1.commit });
    expect(v1.commit).toBe(provenance.commit);
    expect(configs.versions.v0.params.gadget).toBe("stride3");
    expect(configs.versions.v1.params.gadget).toBe("pick2");
  });

  it("rebuilds each construction's exact script from its own Python reference", () => {
    expect(adoptPqb(state(v0.seed)).scriptHex).toBe(v0.scriptHex);
    expect(adoptPqb(state(v1.seed, "v1")).scriptHex).toBe(v1.scriptHex);
    // The same seed under the other construction is another script.
    expect(adoptPqb(state(v1.seed)).scriptHex).not.toBe(v1.scriptHex);
  });

  it("matches v1's Python problem bytes and trial digests on all three stages", () => {
    const g = adoptPqb(state(v1.seed, "v1")), manifest = withdrawalSchema.parse(v1.manifest);
    const [locktime, sequence] = pinFields(BigInt(v1.pinNonce));
    const prior = { locktime, sequence, round1: v1.priorSelection, round2: [] };
    for (const [stage, fixture] of v1.stages.entries()) {
      expect(pqbProblem(g.publicStateJson, manifest, stage, prior)).toBe(fixture.problem);
      const packet = pqbPacket(g.publicStateJson, manifest, stage, prior);
      for (const trial of fixture.trials) {
        const got = evaluate(packet, BigInt(trial.nonce), trial.variant, trial.menuIndex, trial.encoding, 0);
        expect(hex(got.digest!)).toBe(trial.digest);
        expect(got.z.toString()).toBe(trial.z);
      }
    }
  });
});

describe("recorded construction", () => {
  it("records v1 in recovery and public state, and leaves v0 as no version", () => {
    const g0 = adoptPqb(state(v0.seed)), g1 = adoptPqb(state(v1.seed, "v1"));
    expect(JSON.parse(g0.stateJson)).not.toHaveProperty("version");
    expect(JSON.parse(g0.publicStateJson)).not.toHaveProperty("version");
    expect(JSON.parse(g1.stateJson).version).toBe("v1");
    expect(JSON.parse(g1.publicStateJson).version).toBe("v1");
    expect(pqbConstructionOf(JSON.parse(g0.publicStateJson))).toBe("v0");
    expect(pqbConstructionOf(JSON.parse(g1.publicStateJson))).toBe("v1");
    // One spelling each: v0 is never written out, and unknown versions are refused.
    expect(() => adoptPqb(state(v0.seed, "v0"))).toThrow();
    expect(() => adoptPqb(state(v0.seed, "v2"))).toThrow();
  });

  it("creates new vaults with the latest construction", () => {
    expect(JSON.parse(generatePqb().publicStateJson).version).toBe(LATEST_VERSION);
  });

  it("binds the table to the script with the construction's layout, and refuses a mislabelled state", () => {
    const g0 = adoptPqb(state(v0.seed)), g1 = adoptPqb(state(v1.seed, "v1"));
    expect(() => validatePqbPublicState(g0.publicStateJson)).not.toThrow();
    expect(() => validatePqbPublicState(g1.publicStateJson)).not.toThrow();
    const { version: _v, ...unlabelled } = JSON.parse(g1.publicStateJson);
    expect(() => validatePqbPublicState(JSON.stringify(unlabelled))).toThrow("round table");
    expect(() => validatePqbPublicState(JSON.stringify({ ...JSON.parse(g0.publicStateJson), version: "v1" })))
      .toThrow("round table");
    const swapped = JSON.parse(g1.publicStateJson);
    [swapped.round_table[0], swapped.round_table[1]] = [swapped.round_table[1], swapped.round_table[0]];
    expect(() => validatePqbPublicState(JSON.stringify(swapped))).toThrow("round table");
  });

  it("gives each vault its own construction's generator commit", () => {
    expect(vaultConfiguration(vaultOf(adoptPqb(state(v0.seed)))).generatorCommit).toBe(PQB_CONSTRUCTION_COMMITS.v0);
    expect(vaultConfiguration(vaultOf(adoptPqb(state(v1.seed, "v1")))).generatorCommit).toBe(PQB_CONSTRUCTION_COMMITS.v1);
  });
});

describe("compatible solver set", () => {
  it("lets a PQB release naming either generator serve vaults of either construction", () => {
    for (const seedState of [state(v0.seed), state(v1.seed, "v1")]) {
      const configuration = vaultConfiguration(vaultOf(adoptPqb(seedState)));
      // The enrolled v0.2.0 release names eccdd09.
      expect(solverServesVault(pqbV020, configuration)).toBe(true);
      expect(solverServesVault({ ...pqbV020, generatorCommit: PQB_CONSTRUCTION_COMMITS.v1 }, configuration)).toBe(true);
      expect(solverServesVault({ ...pqbV020, generatorCommit: "ab".repeat(20) }, configuration)).toBe(false);
      expect(solverServesVault(servedFixture, configuration)).toBe(false);
    }
  });
});

describe("v1 spend", () => {
  it("assembles a v1 witness with a SIGHASH_ALL co-signature within the shared scriptSig bound", () => {
    // Witness assembly only: these default subsets do not solve the real hash puzzles.
    const lock = buildLock("PQB", fromHex(v1.seed), { version: "v1" });
    const manifest = withdrawalSchema.parse(v1.manifest);
    const [locktime, sequence] = pinFields(BigInt(v1.pinNonce));
    const out = assemble(lock, { txid: manifest.funding.txid, vout: 0, amount: 100000 }, [], {
      transaction: pqbTransaction(manifest, sequence, locktime), inputIndex: 1,
      selection: [v1.priorSelection, [0, 1, 2, 4, 5, 6, 7, 8, 10]],
    });
    expect(out.simError).toBeNull();
    expect(out.scriptSig.length).toBeLessThanOrEqual(PQB_MAX_SCRIPTSIG);
    const pushes = parseScript(out.scriptSig), sig = pushes.at(-2)![2]!, pk = pushes.at(-1)![2]!;
    expect(secp256k1.verify(sig.subarray(0, -1), legacySighashAll(out.tx, 1, lock.script), pk,
      { format: "der", prehash: false, lowS: true })).toBe(true);
  });
});

describe("one seed, two constructions", () => {
  it("shares the table, so it is the same one-time material", () => {
    const a = adoptPqb(state(v1.seed)), b = adoptPqb(state(v1.seed, "v1"));
    expect(a.scriptHash).not.toBe(b.scriptHash);
    expect(pqbSharesSecrets(a.publicStateJson, b.publicStateJson)).toBe(true);
    expect(pqbSharesSecrets(a.publicStateJson, generatePqb().publicStateJson)).toBe(false);
  });

  it("refuses to register it again for the same owner, under either construction", async () => {
    const store = new MemoryStore(), token = "a".repeat(43);
    const owner = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(3), true)).address!;
    await store.put({ pk: `SESSION#${createHash("sha256").update(token).digest("hex")}`, sk: "AUTH", version: 0,
      owner, network: "mainnet", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const app = createApp(store, { enabled: true, chain: { scriptFunded: async () => false } as never });
    const register = (g: ReturnType<typeof adoptPqb>) => app.request("/api/vaults", { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(withVaultConfiguration({ id: randomUUID(), name: "pqb", createdAt: new Date().toISOString(),
        network: "mainnet", config: "PQB", scriptHex: g.scriptHex, scriptHash: g.scriptHash,
        publicStateJson: g.publicStateJson, paymentAddress: owner, status: "unfunded" })) });
    expect((await register(adoptPqb(state(v1.seed)))).status).toBe(201);
    const reused = await register(adoptPqb(state(v1.seed, "v1")));
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "vault_secrets_reused" });
    expect((await register(generatePqb())).status).toBe(201);
    expect((await store.list(`OWNER#${owner}`, "VAULT#"))).toHaveLength(2);
  });
});
