let worker: Worker | undefined;
const pending = new Map<
  string,
  { resolve: (value: any) => void; reject: (reason: Error) => void }
>();
function call<T>(method: string, args: string[] = []): Promise<T> {
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
export async function generateQsb() {
  return JSON.parse(await call<string>("generate")) as {
    stateJson: string;
    publicStateJson: string;
    scriptHex: string;
    scriptHash: string;
  };
}
export const validateRecovery = (stateJson: string) =>
  call<string>("validate", [stateJson]);
export const assembleQsb = (
  state: string,
  manifest: unknown,
  solution: unknown,
) =>
  call<string>("assemble", [
    state,
    JSON.stringify(manifest),
    JSON.stringify(solution),
  ]);
export function lockQsb() {
  worker?.terminate();
  worker = undefined;
  for (const p of pending.values()) p.reject(new Error("Vault locked."));
  pending.clear();
}
