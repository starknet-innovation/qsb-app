import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { runCli } from "../sdk/cli";
import { loopbackTestSigner } from "./test-signer";
import { API } from "./sdk-fixture";
import { ExternalAgentError } from "../sdk/agent";
vi.mock("../sdk/agent", async importOriginal => {
  const actual = await importOriginal<typeof import("../sdk/agent")>();
  return { ...actual, externalAgent: vi.fn(actual.externalAgent) };
});
function setup() {
  const cwd = mkdtempSync(path.join(tmpdir(), "qsb-cli-diagnostics-"));
  const signer = loopbackTestSigner(new Uint8Array(32).fill(11), API);
  const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
  const output = { text: "" }; stderr.on("data", c => output.text += c);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ vaults: [] })));
  const io = { cwd, env: { QSB_API_URL: API, QSB_AGENT: "/missing-agent", QSB_ADDRESS: signer.address, QSB_PUBLIC_KEY: signer.publicKey },
    stdin, stdout, stderr, interactive: false, fetch: fetcher as typeof fetch };
  return { io, output, fetcher };
}
it("rejects unattended submission without touching an open stdin or calling the API", async () => {
  const { io, output, fetcher } = setup();
  expect(await runCli(["withdraw", "submit", "--signed", "unused.json"], io)).toBe(2);
  expect(output.text).toContain("--approve-txid");
  expect(io.stdin.listenerCount("data")).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
});
it("identifies missing options and existing output files without printing path content", async () => {
  const { io, output } = setup();
  expect(await runCli(["vault", "create", "--descriptor", "unused.json"], io)).toBe(2);
  expect(output.text).toContain("--name is required");
  writeFileSync(path.join(io.cwd, "private-looking-path"), "private-file-content");
  expect(await runCli(["withdraw", "prepare", crypto.randomUUID(), "--out", "private-looking-path"], io)).toBe(2);
  expect(output.text).toContain("output file already exists");
  expect(output.text).not.toContain("private-looking-path"); expect(output.text).not.toContain("private-file-content");
});
it("prints allowlisted API codes rather than the server's arbitrary error text", async () => {
  const { io, output } = setup();
  io.fetch = vi.fn(async () => new Response(JSON.stringify({ code: "session_expired", error: "private-server-error" }), { status: 401 })) as typeof fetch;
  expect(await runCli(["config"], io)).toBe(1);
  expect(output.text).toContain("API session_expired"); expect(output.text).not.toContain("private-server-error");
});
it("identifies journal claim failures without printing arbitrary agent details", async () => {
  const { externalAgent } = await import("../sdk/agent");
  const { io, output } = setup();
  const signer = loopbackTestSigner(new Uint8Array(32).fill(11), API);
  vi.mocked(externalAgent).mockReturnValueOnce({ signer, credentials: { get: async () => { throw new ExternalAgentError("authorizations.claim", "private-agent-error"); } },
    custody: {} as never, authorizations: {} as never });
  expect(await runCli(["vault", "list"], io)).toBe(1);
  expect(output.text).toContain("authorization claim failed"); expect(output.text).toContain("never reset claims");
  expect(output.text).not.toContain("private-agent-error");
});
