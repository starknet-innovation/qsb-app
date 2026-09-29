import { startQsbRuntime } from "./qsb-runtime";
// Loaded from the same origin; no recovery material is transmitted.
let runtime: ReturnType<typeof startQsbRuntime> | undefined;
async function getRuntime() {
  if (!runtime)
    runtime = (async () => {
      const runtimeUrl = new URL("/pyodide/pyodide.mjs", self.location.origin)
        .href;
      const { loadPyodide } = await import(/* @vite-ignore */ runtimeUrl);
      const py = await loadPyodide({
        indexURL: new URL("/pyodide/", self.location.origin).href,
        stdout: () => {},
        stderr: () => {},
      });
      return startQsbRuntime(py, async (file) => {
        const response = await fetch(`/qsb/${file}`);
        if (!response.ok) throw new Error("Unable to load QSB runtime");
        return new Uint8Array(await response.arrayBuffer());
      });
    })();
  return runtime;
}
self.onmessage = async (event: MessageEvent) => {
  const { id, method, args } = event.data;
  try {
    const result = (await getRuntime()).call(method, args || []);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : "QSB operation failed",
    });
  }
};
