import { readFile } from "node:fs/promises";
import { loadPyodide } from "pyodide";
import { startQsbRuntime, type QsbMethod } from "../src/lib/qsb-runtime";
import { qsbOperations } from "../src/lib/qsb-operations";

/** The local QSB operations the SDK needs; the same operations src/lib/qsb.ts runs in the browser. */
export type LocalQsb = ReturnType<typeof qsbOperations> & { lockQsb(): void };
type GeneratedQsb = Awaited<ReturnType<LocalQsb["generateQsb"]>>;
/**
 * This package's own runtime. `adoptQsb` takes recovery state generated elsewhere and returns what
 * `generateQsb` returns for it, after the bridge rebuilds it with the pipeline's setup from its HORS
 * secrets and finds every field the same.
 */
export type BundledQsb = LocalQsb & { adoptQsb(stateJson: string): Promise<GeneratedQsb> };
/**
 * A refused supplied recovery state, from `adoptQsb` or `vaults.create`; the message says what didn't
 * match. Any other failure is a plain Error.
 */
export class RefusedState extends Error {
  override name = "RefusedState";
}

// The vendored generator sources the browser serves from /qsb/, checked against the same manifest.
const sources = new URL("../public/qsb/", import.meta.url);

/**
 * A Python error's message is its whole traceback; keep only the raised message. The bridge's
 * RefusedError, raised only by adopt, becomes a RefusedState.
 */
function pythonError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error("QSB operation failed");
  if (error.constructor.name !== "PythonError") return new Error(error.message);
  const lines = error.message.trim().split("\n");
  const message = (lines[lines.length - 1] ?? "").replace(/^[A-Za-z_.]+(?:Error|Exception): /, "");
  return (error as { type?: unknown }).type === "RefusedError" ? new RefusedState(message) : new Error(message);
}

/**
 * Pyodide in this Node process, running the bridge from public/qsb. Nothing is
 * downloaded: Pyodide comes from the installed npm package and every Python
 * source is checked against public/qsb/manifest.json before it runs. Calls
 * after `lockQsb` start a fresh interpreter.
 */
export function nodeQsb(): BundledQsb {
  let runtime: ReturnType<typeof startQsbRuntime> | undefined;
  const start = () =>
    (runtime ??= (async () => {
      const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
      return startQsbRuntime(
        py,
        async (file) => new Uint8Array(await readFile(new URL(file, sources))),
      );
    })().catch((error) => {
      runtime = undefined;
      throw error;
    }));
  const run = async (method: QsbMethod, args: string[] = []) => {
    const loaded = await start();
    try {
      return loaded.call(method, args);
    } catch (error) {
      throw pythonError(error);
    }
  };
  return {
    ...qsbOperations(run),
    async adoptQsb(stateJson) {
      if (typeof stateJson !== "string") throw new RefusedState("the recovery state is not JSON text");
      return JSON.parse(await run("adopt", [stateJson])) as GeneratedQsb;
    },
    lockQsb() {
      runtime = undefined;
    },
  };
}
