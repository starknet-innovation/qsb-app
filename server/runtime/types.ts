import { z } from "zod";

export const RELEASE_MANIFEST_FORMAT = "qsb-source-release-manifest-v1" as const;
export const SUPERVISED_PROFILE_ID = "qsb-supervised-pin-v4-subset-v5" as const;

export const phaseSchema = z.enum(["pinning", "round1", "round2", "verification"]);
export type Phase = z.infer<typeof phaseSchema>;

export const releaseBindingSchema = z
  .object({
    profileId: z.literal(SUPERVISED_PROFILE_ID),
    sourceManifestFormat: z.literal(RELEASE_MANIFEST_FORMAT),
    nativeBinariesEnrolled: z.literal(false),
    broadcastAuthorized: z.literal(false),
  })
  .strict();
export type ReleaseBinding = z.infer<typeof releaseBindingSchema>;

export const reservationSchema = z
  .object({
    txid: z.string().regex(/^[a-f0-9]{64}$/i),
    vout: z.number().int().min(0).max(0xffffffff),
  })
  .strict();

export const launchBindingsSchema = z
  .object({
    owner: z.string().min(1),
    requestId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    phase: phaseSchema,
    slot: z.number().int().min(0).max(31),
    reservations: z.array(reservationSchema).min(1).max(8),
    capability: z.literal("search-only"),
    configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
    release: releaseBindingSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type LaunchBindings = z.infer<typeof launchBindingsSchema>;

export const acknowledgementSchema = z
  .object({
    kind: z.literal("process-started"),
    processId: z.string().min(1),
    deadline: z.string().datetime(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    searchSuccess: z.literal(false),
    wholeRangeCovered: z.literal(false),
  })
  .strict();
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

export const simulatedHitFactsSchema = z
  .object({
    solverFacts: z.literal("simulated"),
    chainFacts: z.literal("simulated"),
    cpuVerification: z.literal("simulated"),
    binariesProduced: z.literal(false),
    freshSearch: z.literal(false),
    wholeRangeCovered: z.literal(false),
  })
  .strict();
export type SimulatedHitFacts = z.infer<typeof simulatedHitFactsSchema>;

export const terminalEvidenceSchema = z
  .object({
    format: z.literal("qsb-terminal-evidence-v1"),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    processId: z.string().min(1),
    outcome: z.enum([
      "process-exit",
      "verified-hit",
      "failed",
      "drained",
      "cancelled",
    ]),
    hitVerified: z.boolean(),
    wholeRangeCovered: z.literal(false),
    solverFacts: z.enum(["simulated", "not-run"]),
    chainFacts: z.enum(["simulated", "not-run"]),
    cpuVerification: z.enum(["simulated", "enrolled-cpu-verifier", "not-run"]),
    binariesProduced: z.literal(false),
    freshSearch: z.literal(false),
    bundle: z.unknown().optional(),
  })
  .strict();
export type TerminalEvidence = z.infer<typeof terminalEvidenceSchema>;

export const launchStateSchema = z.enum([
  "claimed",
  "launching",
  "uncertain",
  "acknowledged",
  "running",
  "replacing",
  "terminal",
]);
export type LaunchState = z.infer<typeof launchStateSchema>;

export const launchRecordSchema = z
  .object({
    bindings: launchBindingsSchema,
    state: launchStateSchema,
    processId: z.string().min(1).optional(),
    previousProcessIds: z.array(z.string().min(1)).max(8),
    providerId: z.string().min(1).optional(),
    providerOutcome: z.enum(["not-submitted", "submitted", "uncertain"]),
    providerSubmissions: z.number().int().min(0).max(1),
    processStarts: z.number().int().nonnegative(),
    acknowledgement: acknowledgementSchema.optional(),
    evidence: terminalEvidenceSchema.optional(),
    replacement: z.enum(["starting", "uncertain"]).optional(),
  })
  .strict();
export type LaunchRecord = z.infer<typeof launchRecordSchema>;

export const runtimeViewSchema = z
  .object({
    state: z.enum([
      "queued",
      "claimed",
      "launching",
      "acknowledged",
      "uncertain",
      "running",
      "replacing",
      "terminal",
    ]),
    searchRunning: z.boolean(),
  })
  .strict();
export type RuntimeView = z.infer<typeof runtimeViewSchema>;

export function isSearchRunning(record: LaunchRecord): boolean {
  switch (record.state) {
    case "claimed":
    case "launching":
    case "uncertain":
    case "acknowledged":
    case "terminal":
      return false;
    case "replacing":
      return (
        record.providerOutcome === "submitted" && record.providerId !== undefined
      );
    case "running":
      return (
        record.providerOutcome === "submitted" && record.providerId !== undefined
      );
    default: {
      const neverState: never = record.state;
      throw new Error(`Unhandled launch state: ${neverState}`);
    }
  }
}

export function runtimeView(record: LaunchRecord | undefined): RuntimeView {
  if (!record) return { state: "queued", searchRunning: false };
  return { state: record.state, searchRunning: isSearchRunning(record) };
}
