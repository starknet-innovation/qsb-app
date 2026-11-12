import { z } from "zod";
import { pqbHitsSchema } from "./pqb";

const subset = z.array(z.number().int().min(0).max(149)).min(8).max(9)
  .refine(v => new Set(v).size === v.length, "Duplicate HORS index");
/** Complete public solution, also sealed into the local signing backup. */
export const solutionSchema = z.object({
  sequence: z.number().int().min(0).max(0xffffffff),
  locktime: z.number().int().min(0).max(0xffffffff),
  round1: subset, round2: subset, pqb: pqbHitsSchema.optional(),
}).strict().superRefine((s, ctx) => {
  const pqb = s.pqb !== undefined;
  if (s.round1.length !== (pqb ? 8 : 9) || s.round2.length !== 9
    || (pqb && (!s.pqb!.round0 || !s.pqb!.round1 || [...s.round1, ...s.round2].some(i => i > 108)
      || s.round1.some(i => s.round2.includes(i)) || s.sequence < 0x80000000 || s.sequence > 0xfffffffd
      || s.locktime < 500000000 || s.locktime >= 1700000000)))
    ctx.addIssue({ code: "custom", message: "Invalid complete protocol solution" });
});
