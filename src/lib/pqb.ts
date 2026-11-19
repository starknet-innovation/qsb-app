import configs from "../pqb-core/configs.json" with { type: "json" };
import { z } from "zod";
import { buildLock, LATEST_VERSION, VERSIONS, versionParams, type Lock } from "../pqb-core/lock";
import { pqbConstructionOf, PQB_LEGACY_CONSTRUCTION, type PqbConstruction } from "./pqb-identity";
import { assemble } from "../pqb-core/spend";
import {
  stagesFromLock, problemFromPacket, problemTxt, evaluate, solves, parseHit,
  roundSelection, witnessPlan, type Packet, type SolvedStage,
} from "../pqb-core/grind";
import { fromHex, hex } from "../pqb-core/primitives";
import { parseScript, serializeTx, type Tx } from "../pqb-core/tx";
import { pinFields, pinNonceOf } from "../pqb-core/spend";
import type { Job, Withdrawal } from "./model";

const hexBytes = z.string().regex(/^(?:[0-9a-f]{2})+$/);
const menu = z.object({
  r_inv: z.string().regex(/^[1-9][0-9]{0,77}$/),
  variants: z.array(z.object({
    add_n: z.boolean(), odd: z.boolean(),
    points: z.array(z.string().regex(/^04[0-9a-f]{128}$/)).min(12).max(16),
  }).strict()).min(2).max(4),
}).strict();
const publicStage = z.object({ menu }).strict();
/** A construction other than v0, which a vault without `version` uses. */
const laterConstruction = z.enum(VERSIONS as [PqbConstruction, ...PqbConstruction[]])
  .refine(v => v !== PQB_LEGACY_CONSTRUCTION, "v0 is written as no version");
export const pqbPublicStateSchema = z.object({
  config: z.literal("PQB"),
  version: laterConstruction.optional(),
  full_script_hex: hexBytes.max(20000),
  round_table: z.array(z.string().regex(/^[0-9a-f]{18}$/)).length(109),
  stages: z.tuple([publicStage, publicStage, publicStage]),
}).strict().superRefine((s, ctx) => {
  for (const [i, st] of s.stages.entries()) {
    const width = i === 0 ? 12 : 16, points = i === 0 ? 2 : 4;
    if (st.menu.variants.length !== points || st.menu.variants.some(v => v.points.length !== width))
      ctx.addIssue({ code: "custom", message: "Unsupported PQB menu shape" });
  }
  if (new Set(s.round_table).size !== 109)
    ctx.addIssue({ code: "custom", message: "Duplicate PQB table entry" });
});

/**
 * Bind the ordered shared table to the generator's pushes in the actual script: after the
 * TSENT, D_j then C_j (the pick2 gadget) or D_j, F_j=1, C_j (stride-3), per the construction.
 */
export function validatePqbPublicState(text: string) {
  const state = pqbPublicStateSchema.parse(JSON.parse(text));
  const stride3 = versionParams(pqbConstructionOf(state)).gadget === "stride3", step = stride3 ? 3 : 2;
  const tokens = parseScript(fromHex(state.full_script_hex));
  const one = (i: number) => tokens[i]?.[1] === 0x51 ||
    (tokens[i]?.[2]?.length === 1 && tokens[i][2]![0] === 1);
  const candidates: string[][] = [];
  for (let start = 1; start + state.round_table.length * step <= tokens.length; start++) {
    if (!one(start - 1)) continue; // TSENT, followed by the table in setup order.
    const table: string[] = [];
    for (let j = 0; j < state.round_table.length; j++) {
      const pos = start + step * j, signature = tokens[pos]?.[2], commitment = tokens[pos + step - 1]?.[2];
      if (signature?.length !== 9 || (stride3 && !one(pos + 1)) || commitment?.length !== 20) break;
      table.push(hex(signature));
    }
    if (table.length === state.round_table.length) candidates.push(table);
  }
  if (candidates.length !== 1 || candidates[0].some((sig, i) => sig !== state.round_table[i]))
    throw new Error("PQB round table does not match the ordered table in its locking script.");
  return state;
}

const recovery = z.object({ config: z.literal("PQB"), seed: z.string().regex(/^[0-9a-f]{64}$/),
  version: laterConstruction.optional() }).strict();
/** The vault's lock, built with the construction its recovery state names (v0 when none). */
const recoveryLock = (state: z.infer<typeof recovery>) =>
  buildLock("PQB", fromHex(state.seed), { version: state.version ?? PQB_LEGACY_CONSTRUCTION });
const hit = z.string().min(1).max(200);
export const pqbHitsSchema = z.object({ pinning: hit, round0: hit.optional(), round1: hit.optional() }).strict();
export type PqbHits = z.infer<typeof pqbHitsSchema>;

function publicState(lock: Lock): string {
  return JSON.stringify(pqbPublicStateSchema.parse({
    config: "PQB", ...(lock.version === PQB_LEGACY_CONSTRUCTION ? {} : { version: lock.version }), full_script_hex: hex(lock.script), round_table: lock.detail.dsig.map(hex),
    stages: stagesFromLock(lock).map(st => ({ menu: {
      r_inv: st.menuR!.r_inv.toString(),
      variants: st.menuR!.variants.map(v => ({ add_n: v.add_n, odd: v.odd, points: v.points })),
    } })),
  }));
}

export function adoptPqb(stateJson: string) {
  const state = recovery.parse(JSON.parse(stateJson));
  const lock = recoveryLock(state);
  if (!lock.detail.realPuzzles || lock.script.length > 10000 || lock.detail.ops > 201)
    throw new Error("Invalid PQB lock");
  return { stateJson: JSON.stringify(state), publicStateJson: publicState(lock),
    scriptHex: hex(lock.script), scriptHash: lock.sha256 };
}

/** A new vault uses the latest construction. */
export function generatePqb() {
  return adoptPqb(JSON.stringify({ config: "PQB", seed: hex(crypto.getRandomValues(new Uint8Array(32))),
    ...(LATEST_VERSION === PQB_LEGACY_CONSTRUCTION ? {} : { version: LATEST_VERSION }) }));
}

/** Same two-input, single-output intent as QSB: helper first, legacy vault second. */
export function pqbTransaction(m: Withdrawal, sequence = 0x80000000, locktime = 500000000): Tx {
  if (BigInt(m.helper.value) + BigInt(m.funding.value) !== BigInt(m.outputValue) + BigInt(m.fee)
    || BigInt(m.outputValue) <= 0n || BigInt(m.fee) <= 0n
    || (m.helper.txid.toLowerCase() === m.funding.txid.toLowerCase() && m.helper.vout === m.funding.vout))
    throw new Error("Invalid PQB spend amounts or inputs");
  return { version: 1, locktime, vin: [
    { txid: m.helper.txid, vout: m.helper.vout, sequence: 0xfffffffe, scriptSig: new Uint8Array() },
    { txid: m.funding.txid, vout: m.funding.vout, sequence, scriptSig: new Uint8Array() },
  ], vout: [{ value: BigInt(m.outputValue), script: fromHex(m.outputScript) }] };
}

/** Rebuild the public problem from the approved manifest, never from worker-supplied bytes. */
export function pqbPacket(publicStateJson: string, m: Withdrawal, stage: number,
  solution?: Job["solution"]): Packet {
  const s = validatePqbPublicState(publicStateJson);
  if (![0, 1, 2].includes(stage)) throw new Error("Invalid PQB stage");
  const nonce = stage ? pinNonceOf(solution!.locktime, solution!.sequence) : 0n;
  if (nonce === null) throw new Error("Invalid PQB pinning nonce");
  const [lt, seq] = pinFields(nonce);
  const used = stage === 2 ? solution!.round1 : [];
  if (stage === 2 && (used.length !== 8 || new Set(used).size !== 8
    || used.some(i => !Number.isInteger(i) || i < 0 || i >= 109))) throw new Error("Invalid PQB prior selection");
  const live = Array.from({ length: 109 }, (_, j) => j).filter(j => !used.includes(j));
  return { stage, kind: stage ? "round" : "pinning", predicate: "sha256", sha1_chain: false,
    scriptpubkey: s.full_script_hex, tx_template: hex(serializeTx(pqbTransaction(m, seq, lt))),
    n_in: 1, hashtype: 1, only_33_byte_keys: stage === 2, ladder_levels: 0, verify_form: false,
    menu: s.stages[stage].menu, ...(stage ? { round_table: s.round_table, live_slots: live,
      used_slots: used, table_n: live.length, t: stage === 1 ? 8 : 9, deletions_before: [], pin_nonce: nonce.toString() } : {}),
  };
}

export function pqbProblem(publicStateJson: string, m: Withdrawal, stage: number, solution?: Job["solution"]) {
  return problemTxt(problemFromPacket(pqbPacket(publicStateJson, m, stage, solution)));
}

/** CPU reference independent of the CUDA grinder: canonical transaction + FindAndDelete. */
export function checkPqbHit(packet: Packet, line: string): SolvedStage | null {
  const pattern = packet.kind === "pinning"
    ? /^[0-9]{1,10} [0-9]{1,10}( [0-9]{1,3}){4}$/
    : new RegExp(`^[0-9]{1,3}(,[0-9]{1,3}){${packet.t! - 1}}( [0-9]{1,3}){4}$`);
  if (line.length > 200 || !pattern.test(line)) throw new Error("Invalid PQB candidate");
  const parsed = parseHit(packet, line);
  if (packet.kind === "round" && line.split(" ")[0].split(",").length !== packet.t)
    throw new Error("Invalid PQB subset size");
  const { digest, z } = evaluate(packet, parsed.nonce, parsed.variant, parsed.menuIndex, parsed.encoding, parsed.ladder);
  if (!digest || digest[0] !== 0x30 || digest[1] !== 0x1d || digest[2] !== 0x02)
    throw new Error("PQB candidate failed CPU verification");
  return solves(packet, digest, z) ? { ...parsed, stage: packet.stage, digest } : null;
}

export function pqbSelection(packet: Packet, line: string): number[] {
  return roundSelection(packet, parseHit(packet, line).nonce);
}

/** Recheck all three public solutions locally before producing any witness or co-signature. */
export function assemblePqb(stateJson: string, m: Withdrawal, solution: NonNullable<Job["solution"]>): string {
  const state = recovery.parse(JSON.parse(stateJson));
  const lock = recoveryLock(state);
  const pub = publicState(lock), hits = pqbHitsSchema.parse(solution.pqb);
  if (!hits.round0 || !hits.round1) throw new Error("Incomplete PQB solution");
  const packets = new Map<number, Packet>(), solved = new Map<number, SolvedStage>();
  for (const [stage, line] of [hits.pinning, hits.round0, hits.round1].entries()) {
    const p = pqbPacket(pub, m, stage, solution), checked = checkPqbHit(p, line);
    if (!checked) throw new Error("PQB solution does not pass the full predicate");
    packets.set(stage, p); solved.set(stage, checked);
  }
  const plan = witnessPlan(lock, packets, solved);
  const [lt, seq] = pinFields(plan.pinNonce!);
  if (!plan.complete || seq !== solution.sequence || lt !== solution.locktime
    || JSON.stringify(plan.selection) !== JSON.stringify([solution.round1, solution.round2]))
    throw new Error("PQB solution changed");
  const tx = pqbTransaction(m, seq, lt);
  const out = assemble(lock, { txid: m.funding.txid, vout: m.funding.vout, amount: Number(m.funding.value) },
    [], { ...plan, pinNonce: plan.pinNonce!, transaction: tx, inputIndex: 1 });
  if (out.simError) throw new Error("PQB witness construction failed: " + out.simError);
  return out.hex;
}

/** Upper bound from the generator's witness layout; script numbers stay below the 1,000-item limit. */
function maxScriptSig(c: (typeof configs.versions)[PqbConstruction]["params"]) {
  const picks = c.t_list;
  return (
    // Puzzle keys use each stage's allowed encoding; dummy signature keys are compressed.
    c.m_list.reduce((sum, m) => sum + (m === 2 || m === 4 ? 34 : 66), 0)
    + picks.reduce((sum, t) => sum + t * 34, 0)
    // Shared chained HORS: first-round preimages have the configured width, later ones are SHA-256.
    + picks.reduce((sum, t, r) => sum + t * (1 + (r === 0 ? c.hors_secret_bytes : 32)), 0)
    + (picks.reduce((sum, t) => sum + t, 0) + c.K.length) * 3
    // Every menu entry and the co-signature are <=73 bytes, each with its one-byte push; cosig key is compressed.
    + (c.K.length + 1) * 74 + 34);
}
/** The largest bound over every construction: a fee quote doesn't depend on the vault's. */
export const PQB_MAX_SCRIPTSIG = Math.max(...VERSIONS.map(v => maxScriptSig(configs.versions[v].params)));
