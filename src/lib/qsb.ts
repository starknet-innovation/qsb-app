import type { QsbMethod } from "./qsb-runtime";
import { qsbOperations } from "./qsb-operations";
// Still exported from here, as before the Node SDK needed it without this module's browser worker.
export { qsbOperations } from "./qsb-operations";
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
export const { generateQsb, validateRecovery, assembleQsb } = qsbOperations(
  (method, args) => call<string>(method, args),
);
export function lockQsb() {
  worker?.terminate();
  worker = undefined;
  for (const p of pending.values()) p.reject(new Error("Vault locked."));
  pending.clear();
}
