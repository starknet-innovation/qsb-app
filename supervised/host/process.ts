import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  fstatSync,
  realpathSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import type { Store } from "../../server/store";
import type {
  LaunchRequest,
  Launcher,
} from "../archive/work/yukon-mainnet-service-enrollment-20260923/dispatch";
import { claimHost, preserveHostEvidence, DISTRIBUTION } from "./claim";
import { HOST_SOURCE } from "./host-hash";
const h = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
export function processIdentity(stat: string) {
  const end = stat.lastIndexOf(")");
  if (!/^\d+ \(/.test(stat) || end < 3)
    throw Error("Malformed process identity");
  const tail = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  if (
    tail.length < 20 ||
    !/^\d+$/.test(tail[1]) ||
    !/^\d+$/.test(tail[2]) ||
    !/^\d+$/.test(tail[19])
  )
    throw Error("Malformed process identity");
  const parentPid = Number(tail[1]),
    pgid = Number(tail[2]);
  if (!Number.isSafeInteger(parentPid) || !Number.isSafeInteger(pgid))
    throw Error("Unrepresentable process identity");
  return { parentPid, pgid, startTicks: tail[19] };
}
/** A FIFO is a consumed stream, not a reusable credential store. Claim before any await. */
export function singleUse() {
  let consumed = false;
  return () => {
    if (consumed)
      throw Error(
        "Credential pipe already assigned; provide a new privately owned FIFO",
      );
    consumed = true;
  };
}
/** Bound bytes across the whole child lifetime, including completed lines. */
export function outputLimiter(limit = 16384) {
  let bytes = 0,
    buffer = "",
    failed = false;
  return (chunk: Buffer) => {
    if (failed) return [];
    bytes += chunk.length;
    if (bytes > limit) {
      failed = true;
      buffer = "";
      throw Error("Oversized host output");
    }
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    return lines;
  };
}
function writeExclusive(path: string, value: string) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const d = openSync("/evidence/host-inputs", "r");
  try {
    fsyncSync(d);
  } finally {
    closeSync(d);
  }
}
/** Only a trusted fixed Linux owner constructs this. The privately supplied FIFO is never read here. */
export function createHostLauncher(store: Store, credentialFd: number) {
  if (
    process.platform !== "linux" ||
    !Number.isSafeInteger(credentialFd) ||
    credentialFd < 3 ||
    !fstatSync(credentialFd).isFIFO() ||
    realpathSync("/evidence") !== "/evidence" ||
    h(readFileSync("/source/manifest.json")) !== DISTRIBUTION ||
    h(readFileSync(join(__dirname, "host.py"))) !== HOST_SOURCE
  )
    throw Error("Fixed Linux runtime/pipe required");
  const pipe = fstatSync(credentialFd, { bigint: true });
  const pending = new Map<string, Promise<unknown>>(),
    consume = singleUse();
  const launch: Launcher = async (input: LaunchRequest) => {
    const request = structuredClone(input);
    consume();
    const currentPipe = fstatSync(credentialFd, { bigint: true });
    if (
      !currentPipe.isFIFO() ||
      currentPipe.dev !== pipe.dev ||
      currentPipe.ino !== pipe.ino
    )
      throw Error("Credential pipe identity changed");
    const claim = await claimHost(store, request);
    try {
      mkdirSync("/evidence/host-inputs", { recursive: true, mode: 0o700 });
      if (lstatSync("/evidence/host-inputs").isSymbolicLink())
        throw Error("Linked host input directory");
      const path = "/evidence/host-inputs/" + claim.invocationId + ".json";
      writeExclusive(path, claim.configJson);
      const child = spawn(
        "/usr/local/bin/python",
        [
          join(__dirname, "host.py"),
          String(process.pid),
          DISTRIBUTION,
          path,
          claim.configHash,
          String(claim.deadlineMs),
        ],
        {
          stdio: ["ignore", "pipe", "ignore", credentialFd],
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            LANG: "C.UTF-8",
            AWS_REGION: "eu-west-1",
            AWS_DEFAULT_REGION: "eu-west-1",
            PYTHONDONTWRITEBYTECODE: "1",
          },
        },
      );
      let acknowledge!: (v: unknown) => void, reject!: (e: Error) => void;
      const started = new Promise<unknown>((yes, no) => {
        acknowledge = yes;
        reject = no;
      });
      let identity: any,
        terminal: any,
        chain = Promise.resolve();
      const decode = outputLimiter();
      const unknown = async (reason: string) => {
        reject(Error("Host outcome unknown: " + reason));
        await preserveHostEvidence(store, claim, "unknown", { reason }).catch(
          () => {},
        );
      };
      // Timing out the acknowledgement never authorizes a replacement. Observers stay attached.
      const ackTimer = setTimeout(() => {
        void unknown("identity acknowledgement deadline exceeded");
      }, 10000);
      const observe = (line: string) => {
        chain = chain
          .then(async () => {
            const event = JSON.parse(line);
            if (event.kind === "identity") {
              if (
                identity ||
                !Number.isSafeInteger(event.pid) ||
                event.pid < 1 ||
                event.parentPid !== child.pid ||
                event.pgid !== event.pid ||
                !/^\d+$/.test(event.startTicks)
              )
                throw Error("Child identity differs");
              const actual = processIdentity(
                readFileSync("/proc/" + event.pid + "/stat", "utf8"),
              );
              if (
                actual.startTicks !== event.startTicks ||
                actual.parentPid !== child.pid ||
                actual.pgid !== event.pgid
              )
                throw Error("Child no longer matches owned identity");
              identity = event;
              writeExclusive(path + ".identity.json", JSON.stringify(event));
              await preserveHostEvidence(store, claim, "identity", event);
              clearTimeout(ackTimer);
              acknowledge(event);
            } else if (event.kind === "terminal") {
              if (
                !identity ||
                terminal ||
                JSON.stringify(event.identity) !==
                  JSON.stringify(
                    Object.fromEntries(
                      Object.entries(identity).filter(([k]) => k !== "kind"),
                    ),
                  ) ||
                event.hostChildReaped !== true ||
                event.providerCleanupVerified !== false ||
                event.searchComplete !== false
              )
                throw Error("Unbound terminal event");
              terminal = event;
              writeExclusive(path + ".terminal.json", JSON.stringify(event));
              await preserveHostEvidence(store, claim, "terminal", event);
            } else throw Error("Unknown host event");
          })
          .catch(() => unknown("observation or publication failed"));
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        try {
          for (const line of decode(chunk)) observe(line);
        } catch {
          void unknown("host output limit exceeded");
        }
      });
      const settled = new Promise((resolve) => {
        child.on("error", () => {
          clearTimeout(ackTimer);
          void unknown("spawn failure").finally(() =>
            resolve({ unknown: true }),
          );
        });
        child.on("close", (code) => {
          clearTimeout(ackTimer);
          void chain.then(async () => {
            if (!terminal) await unknown("terminal evidence missing");
            resolve(terminal ?? { unknown: true, code });
          });
        });
      });
      pending.set(claim.invocationId, settled);
      await started;
      return {
        accepted: true,
        invocationId: request.invocationId,
        executionHash: request.executionHash,
      };
    } catch {
      await preserveHostEvidence(store, claim, "unknown", {
        reason: "launch or identity acknowledgement unresolved",
      }).catch(() => {});
      throw Error("Host launch outcome unresolved; no respawn");
    }
  };
  return {
    launch,
    wait: (invocationId: string) => {
      const p = pending.get(invocationId);
      if (!p) throw Error("No owned process handle");
      return p;
    },
  };
}
