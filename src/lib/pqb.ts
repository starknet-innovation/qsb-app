import config from "../pqb-core/configs.json" with { type: "json" };
import { z } from "zod";
import { buildLock, type Lock } from "../pqb-core/lock";
import { assemble } from "../pqb-core/spend";
import {
  stagesFromLock, problemFromPacket, problemTxt, evaluate, solves, parseHit,
  roundSelection, witnessPlan, mineableEncoding, type Packet, type SolvedStage,
} from "../pqb-core/grind";
import { fromHex, hex } from "../pqb-core/primitives";
import { serializeTx, type Tx } from "../pqb-core/tx";
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
export const pqbPublicStateSchema = z.object({
  config: z.literal("PQB"),
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

const recovery = z.object({ config: z.literal("PQB"), seed: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const hit = z.string().min(1).max(200);
export const pqbHitsSchema = z.object({ pinning: hit, round0: hit.optional(), round1: hit.optional() }).strict();
export type PqbHits = z.infer<typeof pqbHitsSchema>;

function publicState(lock: Lock): string {
  return JSON.stringify(pqbPublicStateSchema.parse({
    config: "PQB", full_script_hex: hex(lock.script), round_table: lock.detail.dsig.map(hex),
    stages: stagesFromLock(lock).map(st => ({ menu: {
      r_inv: st.menuR!.r_inv.toString(),
      variants: st.menuR!.variants.map(v => ({ add_n: v.add_n, odd: v.odd, points: v.points })),
    } })),
  }));
}

export function adoptPqb(stateJson: string) {
  const state = recovery.parse(JSON.parse(stateJson));
  const lock = buildLock("PQB", fromHex(state.seed));
  if (!lock.detail.realPuzzles || lock.script.length > 10000 || lock.detail.ops > 201)
    throw new Error("Invalid PQB lock");
  return { stateJson: JSON.stringify(state), publicStateJson: publicState(lock),
    scriptHex: hex(lock.script), scriptHash: lock.sha256 };
}

export function generatePqb() {
  return adoptPqb(JSON.stringify({ config: "PQB", seed: hex(crypto.getRandomValues(new Uint8Array(32))) }));
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
  const s = pqbPublicStateSchema.parse(JSON.parse(publicStateJson));
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
  return mineableEncoding(parsed.encoding) && solves(packet, digest, z)
    ? { ...parsed, stage: packet.stage, digest } : null;
}

export function pqbSelection(packet: Packet, line: string): number[] {
  return roundSelection(packet, parseHit(packet, line).nonce);
}

/** Recheck all three public solutions locally before producing any witness or co-signature. */
export function assemblePqb(stateJson: string, m: Withdrawal, solution: NonNullable<Job["solution"]>): string {
  const state = recovery.parse(JSON.parse(stateJson));
  const lock = buildLock("PQB", fromHex(state.seed));
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
const picks = config.PQB.t_list;
export const PQB_MAX_SCRIPTSIG =
  // Puzzle keys use each stage's allowed encoding; dummy signature keys are compressed.
  config.PQB.m_list.reduce((sum, m) => sum + (m === 2 || m === 4 ? 34 : 66), 0)
  + picks.reduce((sum, t) => sum + t * 34, 0)
  // Shared chained HORS: first-round preimages have the configured width, later ones are SHA-256.
  + picks.reduce((sum, t, r) => sum + t * (1 + (r === 0 ? config.PQB.hors_secret_bytes : 32)), 0)
  + (picks.reduce((sum, t) => sum + t, 0) + config.PQB.K.length) * 3
  // Every menu entry and the co-signature are <=73 bytes, each with its one-byte push; cosig key is compressed.
  + (config.PQB.K.length + 1) * 74 + 34;
