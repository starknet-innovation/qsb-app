import { spawn } from "node:child_process";
import type { AuthorizationStore, Credentials, ExternalCustody } from "./custody";
import type { Signer } from "./signer";

type AgentOperation = "credentials.get" | "authorizations.get" | "authorizations.claim" |
  "custody.confirmVault" | "custody.authorizeWithdrawal" | "wallet.signPsbt";
/** Carries a local operation identifier only; never the agent's response or stderr. */
export class ExternalAgentError extends Error {
  constructor(readonly operation: AgentOperation, message = `External agent failed (${operation}). Check the agent locally; no response details are logged.`) {
    super(message);
  }
}

/** JSON over pipes to a caller-owned executable. No shell, secret files or credential cache. */
export function externalAgent(executable: string, options: {
  baseUrl: string; address: string; publicKey: string; cwd: string;
  env: Record<string, string | undefined>;
}) {
  const call = (operation: AgentOperation, input: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const child = spawn(executable, [], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0, failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      child.unref();
      reject(new ExternalAgentError(operation));
    };
    const timer = setTimeout(fail, 120000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    // Agent diagnostics can contain secrets. Drain them without echoing or retaining them.
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4000000) return fail();
      chunks.push(chunk);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) return fail();
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!response || Object.keys(response).length !== 1 || !Object.hasOwn(response, "result")) return fail();
        resolve(response.result);
      } catch { fail(); }
    });
    child.stdin.end(JSON.stringify({ format: "qsb-agent-request-v1", operation,
      context: { baseUrl: options.baseUrl, network: "mainnet", address: options.address, publicKey: options.publicKey }, input }) + "\n");
  });
  const string = (value: unknown, operation: AgentOperation) => {
    if (typeof value !== "string") throw new ExternalAgentError(operation, "External agent must return text for this operation.");
    return value;
  };
  const acknowledge = (value: unknown, operation: AgentOperation) => {
    if (value !== true) throw new ExternalAgentError(operation, "External agent did not acknowledge the durable operation.");
  };
  const credentials: Credentials = { get: async () => string(await call("credentials.get", null), "credentials.get") };
  const authorizations: AuthorizationStore = {
    get: async key => { const value = await call("authorizations.get", { key }); return value === null ? undefined : string(value, "authorizations.get"); },
    claim: async (key, value) => acknowledge(await call("authorizations.claim", { key, value }), "authorizations.claim"),
  };
  const custody: ExternalCustody = {
    confirmVault: async vault => acknowledge(await call("custody.confirmVault", { vault }), "custody.confirmVault"),
    authorizeWithdrawal: async request => string(await call("custody.authorizeWithdrawal", request), "custody.authorizeWithdrawal"),
  };
  const signer: Signer = {
    address: options.address, publicKey: options.publicKey,
    signPsbt: async (address, psbt, inputs) => string(await call("wallet.signPsbt", { address, psbt, inputs }), "wallet.signPsbt"),
  };
  return { custody, authorizations, credentials, signer };
}
