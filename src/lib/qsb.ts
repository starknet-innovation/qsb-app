import type { QsbMethod } from "./qsb-runtime";
let worker: Worker | undefined;
const pending = new Map<
  string,
  { resolve: (value: any) => void; reject: (reason: Error) => void }
>();
function call<T>(method: QsbMethod, args: string[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL("./qsb-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    worker.onerror = () => {
      for (const p of pending.values())
        p.reject(new Error("The local QSB worker stopped."));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, method, args });
  });
}
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
export const { generateQsb, validateRecovery, assembleQsb } = qsbOperations(
  (method, args) => call<string>(method, args),
);
export function lockQsb() {
  worker?.terminate();
  worker = undefined;
  for (const p of pending.values()) p.reject(new Error("Vault locked."));
  pending.clear();
}
