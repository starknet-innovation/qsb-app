import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { QSB_SOURCES, startQsbRuntime } from "../src/lib/qsb-runtime";
import { nodeQsb } from "../sdk/runtime";

const file = (name: string) => new Uint8Array(readFileSync(new URL(`../public/qsb/${name}`, import.meta.url)));
function fakePython() {
  return {
    FS: { writeFile: vi.fn() },
    registerJsModule: vi.fn(),
    runPythonAsync: vi.fn(async () => undefined),
    pyimport: vi.fn(),
  };
}

describe("shared QSB runtime bootstrap", () => {
  it("loads exactly the sources the vendored manifest pins", async () => {
    const manifest = JSON.parse(new TextDecoder().decode(file("manifest.json")));
    expect(Object.keys(manifest).sort()).toEqual([...QSB_SOURCES].sort());
    const py = fakePython();
    await startQsbRuntime(py, async (name) => file(name));
    expect(py.FS.writeFile.mock.calls.map(([name]) => name)).toEqual([...QSB_SOURCES]);
    expect(py.runPythonAsync).toHaveBeenCalledOnce();
  });
  it("refuses a changed or unlisted source before Python runs", async () => {
    for (const read of [
      async (name: string) => (name === "bridge.py" ? new TextEncoder().encode("import os\n") : file(name)),
      async (name: string) => {
        if (name !== "manifest.json") return file(name);
        const manifest = JSON.parse(new TextDecoder().decode(file(name)));
        delete manifest["qsb_pipeline.py"];
        return new TextEncoder().encode(JSON.stringify(manifest));
      },
    ]) {
      const py = fakePython();
      await expect(startQsbRuntime(py, read)).rejects.toThrow("QSB source integrity check failed");
      expect(py.runPythonAsync).not.toHaveBeenCalled();
      expect(py.registerJsModule).not.toHaveBeenCalled();
    }
  });
});

describe("Node QSB runtime", () => {
  it("generates and validates real state in Pyodide, and refuses to assemble without a real hit", async () => {
    const qsb = nodeQsb();
    const generated = await qsb.generateQsb();
    const state = JSON.parse(generated.stateJson);
    expect(state.hors_secrets.flat()).toHaveLength(300);
    expect(generated.publicStateJson).not.toContain("hors_secrets");
    expect(generated.scriptHex.length / 2).toBeLessThanOrEqual(10000);
    expect(await qsb.validateRecovery(generated.stateJson)).toBe(generated.scriptHash);
    qsb.lockQsb();
    // A fresh interpreter after locking; the rejection is the bridge's, not a traceback.
    await expect(
      qsb.assembleQsb(
        generated.stateJson,
        {
          funding: { txid: "11".repeat(32), vout: 0, value: "100000" },
          helper: { txid: "22".repeat(32), vout: 1, value: "20000" },
          outputValue: "110000",
          outputScript: `0014${"33".repeat(20)}`,
        },
        { sequence: 2147483648, locktime: 500000000, round1: [0, 1, 2, 3, 4, 5, 6, 7, 8], round2: [10, 11, 12, 13, 14, 15, 16, 17, 18] },
      ),
    ).rejects.toThrow(/^QSB solution failed local assembly$/);
    await expect(qsb.validateRecovery(JSON.stringify({ ...state, hors_secrets: [[], []] }))).rejects.toThrow(
      /^Invalid secret count$/,
    );
    qsb.lockQsb();
  }, 60000);
});
