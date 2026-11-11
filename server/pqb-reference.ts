import { z } from "zod";
import { checkPqbHit, pqbPacket, pqbProblem, pqbSelection } from "../src/lib/pqb";
import { withdrawalSchema, type Job } from "../src/lib/model";
import { pinFields } from "../src/pqb-core/spend";
import { hex, sha256 } from "../src/pqb-core/primitives";

/** Called on the coordinator's CPU, without a provider or a secret-bearing state. */
export function pqbReference(input: unknown) {
  const e = z.object({ action: z.enum(["export", "verify"]), publicStateJson: z.string().max(60000),
    manifest: withdrawalSchema, stage: z.enum(["pinning", "round1", "round2"]),
    solution: z.unknown().optional(), candidates: z.array(z.string().max(200)).max(32).optional(),
  }).strict().parse(input);
  const stage = e.stage === "pinning" ? 0 : e.stage === "round1" ? 1 : 2;
  const solution = e.solution as Job["solution"];
  if (e.action === "export") {
    const raw = new TextEncoder().encode(pqbProblem(e.publicStateJson, e.manifest, stage, solution));
    return { problemBase64: Buffer.from(raw).toString("base64"), problemSha256: hex(sha256(raw)) };
  }
  const packet = pqbPacket(e.publicStateJson, e.manifest, stage, solution);
  // Every line is re-derived, including lines after the first full solution.
  const checked = (e.candidates ?? []).map(line => ({ line, hit: checkPqbHit(packet, line) }));
  const selected = checked.find(c => c.hit);
  if (!selected) return { valid: false, derOnly: true };
  const [locktime, sequence] = stage === 0 ? pinFields(selected.hit!.nonce) : [solution!.locktime, solution!.sequence];
  return { valid: true, sequence, locktime, candidate: selected.line,
    ...(stage ? { indices: pqbSelection(packet, selected.line) } : {}) };
}
