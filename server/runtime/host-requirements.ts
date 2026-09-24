import { z } from "zod";

export const HOST_REQUIREMENTS = {
  format: "qsb-execution-host-requirements-v1",
  productionHostSelected: false,
  separateFromHistoricalLambda: true,
  processOwnership: "linux-pid",
  credentialChannel: "private-reference-only",
  evidence: "persistent-directory",
  cpuContainer: "owned-child-not-enrolled",
  apiAndSearchMayBeSeparateComponents: true,
} as const;

export type DirectoryIdentity = {
  device: number;
  inode: number;
  mode: number;
  uid: number;
  gid: number;
};

export function directoryIdentity(stat: {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
}): DirectoryIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
  };
}

/** World write is always exposed. Group write is exposed until group membership is verified. */
export function directoryExposesWrite(
  mode: number,
  groupMembershipVerified = false,
): boolean {
  if ((mode & 0o002) !== 0) return true;
  return (mode & 0o020) !== 0 && !groupMembershipVerified;
}

export function compareDirectoryIdentity(
  bound: DirectoryIdentity,
  current: DirectoryIdentity | undefined,
): "intact" | "replaced" | "missing" {
  if (!current) return "missing";
  if (
    current.device !== bound.device ||
    current.inode !== bound.inode ||
    current.uid !== bound.uid ||
    current.gid !== bound.gid ||
    current.mode !== bound.mode
  )
    return "replaced";
  return "intact";
}

export type HostPermissionClaim = {
  enforcedBy: "host-mount" | "resolver-check" | "path-string";
};

export function acceptHostPermissionClaim(claim: HostPermissionClaim): {
  accepted: false;
  reason: string;
} {
  switch (claim.enforcedBy) {
    case "resolver-check":
    case "path-string":
      return {
        accepted: false,
        reason: "Resolver checks do not replace host permissions.",
      };
    case "host-mount":
      return {
        accepted: false,
        reason:
          "Host mount options must be recorded on the selected host. This checkout cannot verify them.",
      };
    default: {
      const neverEnforced: never = claim.enforcedBy;
      throw new Error(`Unhandled permission claim: ${neverEnforced}`);
    }
  }
}

export function validateDeclaredPrivilegeBoundary(boundary: {
  privileged: boolean;
  dockerSocketMounted: boolean;
  hostPidNamespaceShared: boolean;
  childMayReplaceHostMounts: boolean;
}): { accepted: boolean; reason?: string } {
  if (
    boundary.privileged ||
    boundary.dockerSocketMounted ||
    boundary.hostPidNamespaceShared ||
    boundary.childMayReplaceHostMounts
  )
    return {
      accepted: false,
      reason: "Child container privilege boundary is too wide.",
    };
  return { accepted: true };
}

const forbiddenKeys = new Set([
  "apikey",
  "apisecret",
  "secret",
  "secretstring",
  "password",
  "passphrase",
  "privatekey",
  "authorization",
  "mnemonic",
  "seed",
  "walletbackup",
  "token",
  "accesstoken",
  "accesskey",
  "accesskeyid",
  "secretaccesskey",
  "awsaccesskeyid",
  "awssecretaccesskey",
  "sessiontoken",
  "securitytoken",
  "refreshtoken",
  "credential",
  "credentials",
]);
const privateKeyPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const awsAccessKeyPattern = /A(?:K|S)IA[0-9A-Z]{16}/;

function credentialKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function assertNoCredentialMaterial(value: unknown, label = "value"): void {
  if (typeof value === "string") {
    if (privateKeyPattern.test(value) || awsAccessKeyPattern.test(value))
      throw new Error(`CredentialMaterialRejected:${label}`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(credentialKey(key)))
      throw new Error(`CredentialMaterialRejected:${label}.${key}`);
    assertNoCredentialMaterial(child, `${label}.${key}`);
  }
}

const credentialReferencePattern =
  /^operator-secret-reference:[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;

export const credentialReferenceSchema = z
  .object({
    format: z.literal("qsb-private-credential-reference-v1"),
    channel: z.literal("operator-secret-reference"),
    reference: z.string().regex(credentialReferencePattern),
  })
  .strict();

export function acceptCredentialReference(input: unknown): {
  format: "qsb-private-credential-reference-v1";
  channel: "operator-secret-reference";
  reference: string;
  provisioned: false;
  resolvedSecret: null;
} {
  const parsed = credentialReferenceSchema.parse(input);
  return { ...parsed, provisioned: false, resolvedSecret: null };
}

export function credentialProvisioningGap(): {
  provisioned: false;
  operatorStep: string;
} {
  return {
    provisioned: false,
    operatorStep:
      "On the selected host, place the runtime secret in the operator secret store and pass only its reference to the runtime. Do not put the value in a browser request, public configuration, source, log, or issue.",
  };
}

export function assertLogOmitsSecret(line: string, secret: string): void {
  if (secret && line.includes(secret))
    throw new Error("CredentialMaterialRejected:log");
}

export type HostCheck = {
  id: string;
  ok: boolean;
  detail: string;
  operatorStep?: string;
};

export const ISOLATED_HOST_RECORD =
  "docs/runtime-installation/20260924-linux-validation.md" as const;

export type LocalHostProbe = {
  format: "qsb-host-compatibility-report-v1";
  scope: "local-rehearsal";
  productionHostSelected: false;
  certifiesDeploymentHost: false;
  productionCompatible: false;
  isolatedHostRecorded: true;
  isolatedHostRecord: typeof ISOLATED_HOST_RECORD;
  experimentalRuntimePointsAtHistoricalWorkerDockerfile: false;
  checks: HostCheck[];
  operatorSteps: string[];
};

export function probeLocalHost(input: {
  platform: NodeJS.Platform;
  arch: string;
  uid: number | undefined;
  pid: number;
  directory: DirectoryIdentity | undefined;
  imagesEnrolled: false;
  childContainerEnrolled: false;
  privileged: false;
  dockerSocketMounted: false;
  groupMembershipVerified?: boolean;
}): LocalHostProbe {
  const gap = credentialProvisioningGap();
  const checks: HostCheck[] = [
    {
      id: "linux-process-ownership",
      ok:
        input.platform === "linux" &&
        input.pid > 0 &&
        typeof input.uid === "number",
      detail:
        input.platform === "linux"
          ? "This process has a Linux pid. That does not select a deployment host."
          : "This process is not Linux.",
      ...(input.platform === "linux"
        ? {}
        : {
            operatorStep:
              "Select a Linux host that can own the search process, keep a private credential channel, persist evidence, and run an owned CPU container.",
          }),
    },
    {
      id: "persistent-evidence-directory",
      ok: Boolean(
        input.directory &&
          !directoryExposesWrite(input.directory.mode, input.groupMembershipVerified === true) &&
          input.directory.uid === input.uid,
      ),
      detail: input.directory
        ? "Rehearsal directory ownership was recorded as device and inode. The path is not evidence."
        : "No rehearsal evidence directory was supplied.",
      ...(input.directory &&
      !directoryExposesWrite(input.directory.mode, input.groupMembershipVerified === true) &&
      input.directory.uid === input.uid
        ? {}
        : {
            operatorStep:
              "Create a persistent evidence directory owned by the runtime uid and not writable by other users.",
          }),
    },
    {
      id: "private-credential-channel",
      ok: false,
      detail:
        "Only an operator secret reference is accepted. No credential is provisioned in this checkout.",
      operatorStep: gap.operatorStep,
    },
    {
      id: "owned-cpu-container",
      ok: input.childContainerEnrolled,
      detail: "No owned CPU container image is enrolled in this checkout.",
      operatorStep:
        "On the selected host, run the CPU verifier as an owned child container. Do not treat this rehearsal process as that container.",
    },
    {
      id: "immutable-preloaded-image",
      ok: input.imagesEnrolled,
      detail:
        "No OCI image config, index, or registry manifest is enrolled. The historical 000000000000 ECR reference is not deployable.",
      operatorStep:
        "The experimental runtime is npm run build:optimized (worker/optimized/Dockerfile) and npm run build:runtime (supervised/runtime). The historical worker/Dockerfile is the baseline image and is not that profile. Record the image config digest, index digest, and registry manifest digest separately. The isolated host record is docs/runtime-installation/20260924-linux-validation.md; that host is stopped and is not a selected production host. Do not reuse the historical 000000000000 ECR reference.",
    },
    {
      id: "privilege-boundary",
      ok: input.privileged === false && input.dockerSocketMounted === false,
      detail:
        "This rehearsal does not request a privileged child or a mounted Docker socket.",
      operatorStep:
        "Keep the search child unprivileged and do not mount the Docker socket into it. API hosting and search execution may be separate components; the historical Lambda deployment is not this runtime.",
    },
    {
      id: "execution-architecture",
      ok: input.arch === "x64" || input.arch === "arm64",
      detail: `Local architecture is ${input.arch}. This does not select the GPU execution architecture.`,
      operatorStep:
        "Record the selected host architecture and match it to the enrolled image platform manifest.",
    },
  ];
  return {
    format: "qsb-host-compatibility-report-v1",
    scope: "local-rehearsal",
    productionHostSelected: false,
    certifiesDeploymentHost: false,
    productionCompatible: false,
    isolatedHostRecorded: true,
    isolatedHostRecord: ISOLATED_HOST_RECORD,
    experimentalRuntimePointsAtHistoricalWorkerDockerfile: false,
    checks,
    operatorSteps: checks.flatMap((check) =>
      check.operatorStep ? [check.operatorStep] : [],
    ),
  };
}
