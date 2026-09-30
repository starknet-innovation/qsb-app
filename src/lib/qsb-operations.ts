import type { QsbMethod } from "./qsb-runtime";
/** Typed bridge calls over a runtime: this browser worker, or the Node SDK's loader. */
export function qsbOperations(
  run: (method: QsbMethod, args?: string[]) => Promise<string>,
) {
  return {
    async generateQsb() {
      return JSON.parse(await run("generate")) as {
        stateJson: string;
        publicStateJson: string;
        scriptHex: string;
        scriptHash: string;
      };
    },
    validateRecovery: (stateJson: string) => run("validate", [stateJson]),
    assembleQsb: (state: string, manifest: unknown, solution: unknown) =>
      run("assemble", [
        state,
        JSON.stringify(manifest),
        JSON.stringify(solution),
      ]),
  };
}
