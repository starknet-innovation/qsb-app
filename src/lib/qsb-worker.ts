import { ripemd160 } from "@noble/hashes/legacy.js";
// Loaded from the same origin; no recovery material is transmitted.
let runtime: Promise<any> | undefined;
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
      const manifest = await (await fetch("/qsb/manifest.json")).json();
      for (const file of [
        "bitcoin_tx.py",
        "secp256k1.py",
        "qsb_pipeline.py",
        "bridge.py",
      ]) {
        const response = await fetch(`/qsb/${file}`);
        if (!response.ok) throw new Error("Unable to load QSB runtime");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (manifest[file]) {
          const digest = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          if (digest !== manifest[file])
            throw new Error("QSB source integrity check failed");
        }
        py.FS.writeFile(file, bytes);
      }
      py.registerJsModule("qsb_hash", {
        ripemd: (hex: string) =>
          Array.from(
            ripemd160(
              Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16)),
            ),
            (b) => b.toString(16).padStart(2, "0"),
          ).join(""),
      });
      await py.runPythonAsync(
        "import sys\nsys.path.insert(0, '.')\nimport hashlib\nimport qsb_hash\nimport secp256k1\nsecp256k1.ripemd160 = lambda data: bytes.fromhex(qsb_hash.ripemd(data.hex()))\nsecp256k1.hash160 = lambda data: secp256k1.ripemd160(hashlib.sha256(data).digest())\nimport bridge",
      );
      return py;
    })();
  return runtime;
}
self.onmessage = async (event: MessageEvent) => {
  const { id, method, args } = event.data;
  try {
    const py = await getRuntime();
    const bridge = py.pyimport("bridge");
    const result = bridge[method](...(args || []));
    bridge.destroy();
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : "QSB operation failed",
    });
  }
};
