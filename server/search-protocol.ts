import { parseHit, type Packet } from "../src/pqb-core/grind";
import { z } from "zod";
import type { Job, PublicVault } from "../src/lib/model";
import { release } from "../src/lib/model";
import { PQB_GENERATOR_COMMIT, PQB_SEARCH_VERSION } from "../src/lib/pqb-identity";
import type { SolverDescriptor } from "../src/lib/provenance";
import { canonical } from "../src/lib/provenance";
import { pqbWorkerStage } from "./pqb-search";
import { candidateOutput } from "./candidate-output";
import { workRange } from "./search-ranges";

export function assertSolverRuntime(selected: SolverDescriptor) {
  const pqb = selected.protocol === "pqb-v1";
  if (selected.searchVersion !== (pqb ? PQB_SEARCH_VERSION : "ranked-v2")
    || selected.generatorCommit !== (pqb ? PQB_GENERATOR_COMMIT : release.qsbCommit))
    throw new Error("SolverRuntimeMismatch");
}

export function referenceInput(vault: PublicVault, job: Job) {
  return { publicStateJson: vault.publicStateJson, manifest: job.manifest, stage: job.stage,
    ...(vault.config === "PQB" ? (job.solution ? { solution: job.solution } : {})
      : job.solution ? { sequence: job.solution.sequence, locktime: job.solution.locktime } : {}),
  };
}

export function parseParameters(value: unknown, pqb: boolean) {
  return pqb ? z.object({ problemBase64: z.string().max(140000), problemSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(value)
    : z.object({ parameterBase64: z.string().max(140000), parameterSha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(value);
}

export function workerInput(selected: SolverDescriptor, job: Job, attempt: number, parameters: ReturnType<typeof parseParameters>) {
  const pqb = selected.protocol === "pqb-v1";
  return { protocol: selected.protocol, kernelCommit: selected.kernelCommit, manifestHash: job.manifestHash,
    stage: pqb ? pqbWorkerStage(job.stage) : job.stage, attempt, searchVersion: selected.searchVersion, ...parameters,
    ...(!pqb && job.solution ? { sequence: job.solution.sequence, locktime: job.solution.locktime } : {}),
  };
}

export function checkedOutput(raw: unknown, selected: SolverDescriptor, job: Job, attempt: number) {
  const output = candidateOutput.parse(raw), pqb = selected.protocol === "pqb-v1";
  const range = workRange(job.stage, attempt, selected.protocol);
  if (output.kernelCommit !== selected.kernelCommit || output.manifestHash !== job.manifestHash
    || output.stage !== (pqb ? pqbWorkerStage(job.stage) : job.stage) || output.attempt !== attempt)
    throw new Error("CandidateContextMismatch");
  if (canonical(output.workRange) !== canonical(range)) throw new Error("CandidateRangeMismatch");
  if (pqb) {
    const pin = job.stage === "pinning", picks = job.stage === "round1" ? 8 : 9;
    const packet = { kind: pin ? "pinning" : "round", t: picks,
      live_slots: Array.from({ length: job.stage === "round1" ? 109 : 101 }, (_, i) => i) } as Packet;
    const pattern = pin ? /^[0-9]{1,10} [0-9]{1,10}( [0-9]{1,3}){4}$/
      : new RegExp(`^[0-9]{1,3}(,[0-9]{1,3}){${picks - 1}}( [0-9]{1,3}){4}$`);
    for (const candidate of output.candidates) {
      if (!pattern.test(candidate)) throw new Error("Invalid PQB candidate");
      const rank = parseHit(packet, candidate).nonce;
      if (rank < BigInt(range.start) || rank >= BigInt(range.start) + BigInt(range.count))
        throw new Error("CandidateOutsideAssignedRange");
    }
    const report = z.object({ searchVersion: z.literal(PQB_SEARCH_VERSION), verified: z.literal(false),
      trials: z.number().int().nonnegative().optional(), gateHits: z.number().int().nonnegative().optional() }).parse(raw);
    if (output.status === "completed") {
      const width = job.stage === "pinning" ? 72 : job.stage === "round1" ? 192 : 64;
      if (report.trials !== range.count * width || report.gateHits === undefined
        || report.gateHits > report.trials || report.gateHits < output.candidates.length)
        throw new Error("CandidateAccountingMismatch");
      // Match the producer qualification gate. This detects grossly incomplete work;
      // it is a statistical sanity check, not proof of complete enumeration.
      const expectedGateHits = report.trials / 2 ** 24;
      if (Math.abs(report.gateHits - expectedGateHits) > 6 * Math.sqrt(expectedGateHits) + 6)
        throw new Error("CandidateGateCountMismatch");
    }
  }
  return { output, range };
}
