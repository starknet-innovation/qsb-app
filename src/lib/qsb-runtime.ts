import { ripemd160 } from "@noble/hashes/legacy.js";

/**
 * The QSB Python runtime shared by the browser worker (qsb-worker.ts) and the
 * Node SDK (sdk/runtime.ts). Both load the same vendored public/qsb files and
 * check them against public/qsb/manifest.json. Recovery material is only ever
 * an argument to `call`; nothing here sends it anywhere.
 */
export const QSB_SOURCES = [
  "bitcoin_tx.py",
  "secp256k1.py",
  "qsb_pipeline.py",
  "bridge.py",
] as const;
export type QsbMethod = "generate" | "validate" | "assemble";
/** The part of a loaded Pyodide instance the bridge needs. */
export type PythonRuntime = {
  FS: { writeFile(path: string, data: Uint8Array): void };
  registerJsModule(name: string, module: object): void;
  runPythonAsync(code: string): Promise<unknown>;
  pyimport(name: string): any;
};
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Write the pinned sources into `py` and import the bridge. `read` returns a
 * file's bytes from the vendored public/qsb directory. A source whose SHA-256
 * differs from the manifest, or that the manifest doesn't list, is refused
 * before Python sees it.
 */
export async function startQsbRuntime(
  py: PythonRuntime,
  read: (file: string) => Promise<Uint8Array>,
) {
  const manifest = JSON.parse(
    new TextDecoder().decode(await read("manifest.json")),
  ) as Record<string, unknown>;
  for (const file of QSB_SOURCES) {
    const bytes = await read(file);
    const digest = toHex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)),
    );
    if (typeof manifest[file] !== "string" || digest !== manifest[file])
      throw new Error("QSB source integrity check failed");
    py.FS.writeFile(file, bytes);
  }
  py.registerJsModule("qsb_hash", {
    ripemd: (hex: string) =>
      toHex(
        ripemd160(Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16))),
      ),
  });
  await py.runPythonAsync(
    "import sys\nsys.path.insert(0, '.')\nimport hashlib\nimport qsb_hash\nimport secp256k1\nsecp256k1.ripemd160 = lambda data: bytes.fromhex(qsb_hash.ripemd(data.hex()))\nsecp256k1.hash160 = lambda data: secp256k1.ripemd160(hashlib.sha256(data).digest())\nimport bridge",
  );
  return {
    call(method: QsbMethod, args: string[]): string {
      const bridge = py.pyimport("bridge");
      try {
        return bridge[method](...args);
      } finally {
        bridge.destroy();
      }
    },
  };
}
