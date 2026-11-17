import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { externalAgent } from "../sdk/agent";

it("never includes an external manager's error payload or diagnostics in an SDK error", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "qsb-agent-error-"));
  const program = path.join(cwd, "agent");
  writeFileSync(program, `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end', () => {
  console.error('private-recovery-material');
  console.log(JSON.stringify({ error: 'private-recovery-material' }));
});\n`, { mode: 0o700 });
  const agent = externalAgent(program, { baseUrl: "https://app.example", address: "public", publicKey: "public", cwd, env: {} });
  const error = await agent.credentials.get().catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("External agent failed");
  expect(String(error)).not.toContain("private-recovery-material");
});

it("refuses a manager that does not acknowledge durable storage", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "qsb-agent-ack-"));
  const program = path.join(cwd, "agent");
  writeFileSync(program, `#!${process.execPath}
process.stdin.resume(); process.stdin.on('end', () => console.log('{"result":false}'));\n`, { mode: 0o700 });
  const agent = externalAgent(program, { baseUrl: "https://app.example", address: "public", publicKey: "public", cwd, env: {} });
  await expect(agent.authorizations.claim("public-key", "public-value")).rejects.toThrow("did not acknowledge");
});
