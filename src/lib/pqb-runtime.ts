import { generatePqb, adoptPqb, assemblePqb } from "./pqb";
import { withdrawalSchema, type Job } from "./model";

const methods = ["pqb_generate", "pqb_validate", "pqb_assemble"] as const;
export type PqbMethod = (typeof methods)[number];
export function isPqbMethod(method: unknown): method is PqbMethod {
  return typeof method === "string" && (methods as readonly string[]).includes(method);
}
/** Runs in the browser's local worker, or directly in the SDK's Node process. */
export function runPqbOperation(method: PqbMethod, args: string[]): string {
  switch (method) {
    case "pqb_generate": return JSON.stringify(generatePqb());
    case "pqb_validate": return adoptPqb(args[0]).scriptHash;
    case "pqb_assemble": return assemblePqb(args[0], withdrawalSchema.parse(JSON.parse(args[1])),
      JSON.parse(args[2]) as NonNullable<Job["solution"]>);
  }
}
