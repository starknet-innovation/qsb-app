import { afterEach, expect, it, vi } from "vitest";

it("routes PQB creation, recovery and assembly through the browser worker and locks pending work", async () => {
  vi.resetModules();
  const instances: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    requests: { id: string; method: string; args: string[] }[] = [];
    terminate = vi.fn();
    constructor() { instances.push(this); }
    postMessage(data: { id: string; method: string; args: string[] }) { this.requests.push(data); }
    reply(result: string) { this.onmessage?.({ data: { id: this.requests.at(-1)!.id, result } }); }
  }
  vi.stubGlobal("Worker", FakeWorker);
  const qsb = await import("../src/lib/qsb");
  const created = qsb.generateQsb("PQB");
  expect(instances).toHaveLength(1);
  const worker = instances[0];
  expect(worker.requests.at(-1)?.method).toBe("pqb_generate");
  const generated = { stateJson: '{"config":"PQB","seed":"public synthetic"}',
    publicStateJson: "{}", scriptHex: "51", scriptHash: "synthetic-hash" };
  worker.reply(JSON.stringify(generated));
  await expect(created).resolves.toEqual(generated);
  const recovery = qsb.validateRecovery(generated.stateJson);
  expect(worker.requests.at(-1)).toMatchObject({ method: "pqb_validate", args: [generated.stateJson] });
  worker.reply(generated.scriptHash);
  await expect(recovery).resolves.toBe(generated.scriptHash);
  const assembled = qsb.assembleQsb(generated.stateJson, { public: "manifest" }, { public: "solution" });
  expect(worker.requests.at(-1)?.method).toBe("pqb_assemble");
  worker.reply("synthetic-transaction");
  await expect(assembled).resolves.toBe("synthetic-transaction");
  const pending = qsb.generateQsb("PQB");
  qsb.lockQsb();
  await expect(pending).rejects.toThrow("Vault locked");
  expect(worker.terminate).toHaveBeenCalledOnce();
});
afterEach(() => vi.unstubAllGlobals());
