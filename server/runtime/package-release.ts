import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import archived from "../../src/lib/releases/qsb-config-a-ranked-v2.json";
import {
  componentForPath,
  enrolledSourcePaths,
  historicalCandidateRoots,
  optimizedSubsetRoot,
} from "./closure";
import { assertInsideRepo, sha256Hex } from "./identity";
import { RELEASE_MANIFEST_FORMAT } from "./types";

export type AbsentIdentity = {
  status: "not-produced";
  value: null;
  reason: string;
};

const notProduced = (reason: string): AbsentIdentity => ({
  status: "not-produced",
  value: null,
  reason,
});

export type SourceReleaseManifest = {
  format: typeof RELEASE_MANIFEST_FORMAT;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  sourceCommit: {
    status: "unbound";
    value: null;
    reason: string;
  };
  buildInputs: {
    node: ">=22";
    nodeSource: "README.md";
    packageJsonSha256: string;
    packageLockSha256: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    compiler: "CUDA 12.8.1 nvcc";
    cudaArchDefault: string;
    dockerfileFlags: { pinning: string[]; historicalSubset: string[] };
    defaultArchFlags: { pinning: string[]; historicalSubset: string[] };
    images: { build: string; runtime: string };
    runpodPin: string;
    imageBuildStatus: "not-produced";
  };
  releases: {
    pinning: {
      role: "historical-pipeline-stage";
      replacesSolverPipeline: false;
      selectedByWorkerDockerfile: true;
      compatiblePipelinePartner: "historicalSubset";
      sourcesEnrolled: boolean;
    };
    historicalSubset: {
      role: "historical-pipeline-stage";
      replacesSolverPipeline: false;
      selectedByWorkerDockerfile: true;
      compatiblePipelinePartner: "pinning";
      sourcesEnrolled: boolean;
    };
    optimizedSubset: {
      role: "isolated-research";
      replacesSolverPipeline: false;
      selectedByWorkerDockerfile: false;
      compatiblePipelinePartner: null;
      sourcesEnrolled: boolean;
      note: string;
    };
  };
  identities: {
    sourceFiles: Record<string, string>;
    components: Record<string, string>;
    nativeBinaries: {
      pinning: AbsentIdentity;
      historicalSubset: AbsentIdentity;
      optimizedSubset: AbsentIdentity;
    };
    imageConfig: AbsentIdentity;
    ociIndex: AbsentIdentity;
    registryManifest: AbsentIdentity & {
      historicalPlaceholder: string;
      placeholderIsDeployable: false;
    };
  };
  privateEvidence: string[];
};

export function parseWorkerDockerfile(text: string): {
  buildImage: string;
  runtimeImage: string;
  pinningFlags: string[];
  subsetFlags: string[];
  cudaArch: string;
  runpodPin: string;
} {
  if (/^\s*(?:COPY|ADD)\s+\S*research\/optimized-subset/m.test(text))
    throw new Error("Dockerfile selects the optimized subset");
  const froms = [...text.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
  const pinning = text.match(/nvcc\s+(.+?)\s+-o\s+\/pinning\b/);
  const subset = text.match(/nvcc\s+(.+?)\s+-o\s+\/subset\b/);
  const arch = text.match(/^ARG\s+CUDA_ARCH=(\d+)\s*$/m);
  const runpod = text.match(/runpod==([0-9.]+)/);
  if (froms.length !== 2 || !pinning || !subset || !arch || !runpod)
    throw new Error("Worker Dockerfile build inputs could not be read");
  return {
    buildImage: froms[0] ?? "",
    runtimeImage: froms[1] ?? "",
    pinningFlags: pinning[1]?.split(/\s+/) ?? [],
    subsetFlags: subset[1]?.split(/\s+/) ?? [],
    cudaArch: `sm_${arch[1]}`,
    runpodPin: runpod[1] ?? "",
  };
}

function expandArch(flags: string[], arch: string): string[] {
  return flags.map((flag) => flag.replace("${CUDA_ARCH}", arch.slice(3)));
}

function walkFiles(
  root: string,
  relativeDir: string,
  skipGeneratedBytecode: boolean,
): string[] {
  const absolute = assertInsideRepo(root, relativeDir);
  if (!existsSync(absolute)) return [];
  const found: string[] = [];
  const stack = [absolute];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Release path escapes the checkout");
      if (
        skipGeneratedBytecode &&
        (entry.name === "__pycache__" || entry.name.endsWith(".pyc"))
      )
        continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const relative = path.relative(root, full).split(path.sep).join("/");
        assertInsideRepo(root, relative);
        found.push(relative);
      }
    }
  }
  return found.sort();
}

function hashFile(root: string, relativePath: string): string {
  const absolute = assertInsideRepo(root, relativePath);
  return sha256Hex(readFileSync(absolute));
}

export function componentIdentities(
  sourceFiles: Record<string, string>,
): Record<string, string> {
  const grouped = new Map<string, string[]>();
  for (const relativePath of Object.keys(sourceFiles).sort()) {
    const digest = sourceFiles[relativePath];
    if (!digest) continue;
    const component = componentForPath(relativePath);
    const list = grouped.get(component) ?? [];
    list.push(`${relativePath}:${digest}`);
    grouped.set(component, list);
  }
  const components: Record<string, string> = {};
  for (const [component, parts] of [...grouped.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  ))
    components[component] = sha256Hex(parts.sort().join("\n"));
  return components;
}

export function enrollHistoricalPair(
  pinningFiles: readonly string[],
  subsetFiles: readonly string[],
): { pinning: boolean; historicalSubset: boolean } {
  const pinning = pinningFiles.length > 0;
  const historicalSubset = subsetFiles.length > 0;
  if (pinning !== historicalSubset)
    throw new Error("HistoricalCandidatePairIncomplete");
  return { pinning, historicalSubset };
}

export function assertCompatibleStages(manifest: SourceReleaseManifest): void {
  const { pinning, historicalSubset, optimizedSubset } = manifest.releases;
  if (
    pinning.replacesSolverPipeline ||
    historicalSubset.replacesSolverPipeline ||
    optimizedSubset.replacesSolverPipeline ||
    optimizedSubset.selectedByWorkerDockerfile ||
    optimizedSubset.compatiblePipelinePartner !== null ||
    pinning.compatiblePipelinePartner !== "historicalSubset" ||
    historicalSubset.compatiblePipelinePartner !== "pinning" ||
    !pinning.selectedByWorkerDockerfile ||
    !historicalSubset.selectedByWorkerDockerfile
  )
    throw new Error("SubsetCannotReplacePipeline");
}

export function createSourceManifest(root: string): SourceReleaseManifest {
  const dockerfileText = readFileSync(
    assertInsideRepo(root, "worker/Dockerfile"),
    "utf8",
  );
  const built = parseWorkerDockerfile(dockerfileText);
  const packageJson = JSON.parse(
    readFileSync(assertInsideRepo(root, "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const required = enrolledSourcePaths(root);
  for (const relativePath of required) {
    if (!existsSync(assertInsideRepo(root, relativePath)))
      throw new Error(`Missing release input ${relativePath}`);
  }
  const pinningFiles = walkFiles(root, historicalCandidateRoots[0], true);
  const subsetFiles = walkFiles(root, historicalCandidateRoots[1], true);
  const enrolled = enrollHistoricalPair(pinningFiles, subsetFiles);
  const historical = [...pinningFiles, ...subsetFiles];
  const optimized = walkFiles(root, optimizedSubsetRoot, true);
  if (!optimized.length)
    throw new Error("Optimized subset source is not in this checkout");
  const sourcePaths = [...required, ...historical, ...optimized].sort();
  const sourceFiles: Record<string, string> = {};
  for (const relativePath of sourcePaths)
    sourceFiles[relativePath] = hashFile(root, relativePath);
  const components = componentIdentities(sourceFiles);
  const manifest: SourceReleaseManifest = {
    format: RELEASE_MANIFEST_FORMAT,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    sourceCommit: {
      status: "unbound",
      value: null,
      reason:
        "Bind git rev-parse HEAD only after this packaging commit is chosen. This manifest does not invent a commit.",
    },
    buildInputs: {
      node: ">=22",
      nodeSource: "README.md",
      packageJsonSha256: hashFile(root, "package.json"),
      packageLockSha256: hashFile(root, "package-lock.json"),
      dependencies: packageJson.dependencies,
      devDependencies: packageJson.devDependencies,
      compiler: "CUDA 12.8.1 nvcc",
      cudaArchDefault: built.cudaArch,
      dockerfileFlags: {
        pinning: built.pinningFlags,
        historicalSubset: built.subsetFlags,
      },
      defaultArchFlags: {
        pinning: expandArch(built.pinningFlags, built.cudaArch),
        historicalSubset: expandArch(built.subsetFlags, built.cudaArch),
      },
      images: { build: built.buildImage, runtime: built.runtimeImage },
      runpodPin: built.runpodPin,
      imageBuildStatus: "not-produced",
    },
    releases: {
      pinning: {
        role: "historical-pipeline-stage",
        replacesSolverPipeline: false,
        selectedByWorkerDockerfile: true,
        compatiblePipelinePartner: "historicalSubset",
        sourcesEnrolled: enrolled.pinning,
      },
      historicalSubset: {
        role: "historical-pipeline-stage",
        replacesSolverPipeline: false,
        selectedByWorkerDockerfile: true,
        compatiblePipelinePartner: "pinning",
        sourcesEnrolled: enrolled.historicalSubset,
      },
      optimizedSubset: {
        role: "isolated-research",
        replacesSolverPipeline: false,
        selectedByWorkerDockerfile: false,
        compatiblePipelinePartner: null,
        sourcesEnrolled: true,
        note: "research/optimized-subset is not selected by worker/Dockerfile and is not a substitute for the pinning plus historical subset pipeline.",
      },
    },
    identities: {
      sourceFiles,
      components,
      nativeBinaries: {
        pinning: notProduced(
          "This checkout does not compile or ship the pinning executable.",
        ),
        historicalSubset: notProduced(
          "This checkout does not compile or ship the historical subset executable.",
        ),
        optimizedSubset: notProduced(
          "This checkout does not compile or ship the optimized subset executable.",
        ),
      },
      imageConfig: notProduced(
        "No OCI image config digest was produced from this checkout.",
      ),
      ociIndex: notProduced(
        "No OCI index digest was produced from this checkout.",
      ),
      registryManifest: {
        ...notProduced(
          "No registry manifest was pushed. The historical placeholder is not an index, image config, or registry manifest.",
        ),
        historicalPlaceholder: archived.image,
        placeholderIsDeployable: false,
      },
    },
    privateEvidence: [
      "The historical Xverse-signed withdrawal and its spent regtest fixture are not in this checkout.",
      "docs/gpu-validation native traces referenced by tests/test_reference.py are not in this checkout.",
      "Production AWS permissions, Runpod credentials, wallet backups, and operator runtime files are not included.",
      "Native binary hashes and OCI config, index, and registry manifest digests remain unproduced.",
    ],
  };
  assertCompatibleStages(manifest);
  if (manifest.identities.registryManifest.placeholderIsDeployable)
    throw new Error("Placeholder image must not be marked deployable");
  return manifest;
}

export function serializeManifest(manifest: SourceReleaseManifest): string {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return `${JSON.stringify(sortValue(manifest), null, 2)}\n`;
}

export function writePackageTree(
  root: string,
  outDir: string,
  manifest: SourceReleaseManifest = createSourceManifest(root),
): void {
  rmSync(path.join(outDir, "tree"), { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const relativePath of Object.keys(manifest.identities.sourceFiles)) {
    const source = assertInsideRepo(root, relativePath);
    const destination = path.join(outDir, "tree", relativePath);
    if (!destination.startsWith(path.resolve(outDir) + path.sep))
      throw new Error("Release path escapes the checkout");
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  writeFileSync(
    path.join(outDir, "release-manifest.json"),
    serializeManifest(manifest),
  );
}

const absentIdentitySchema = z
  .object({
    status: z.literal("not-produced"),
    value: z.null(),
    reason: z.string().min(1),
  })
  .strict();

const sourceReleaseManifestSchema = z
  .object({
    format: z.literal(RELEASE_MANIFEST_FORMAT),
    mainnetEnabled: z.literal(false),
    broadcastAuthorized: z.literal(false),
    sourceCommit: z
      .object({
        status: z.literal("unbound"),
        value: z.null(),
        reason: z.string().min(1),
      })
      .strict(),
    buildInputs: z
      .object({
        node: z.literal(">=22"),
        nodeSource: z.literal("README.md"),
        packageJsonSha256: z.string().regex(/^[a-f0-9]{64}$/),
        packageLockSha256: z.string().regex(/^[a-f0-9]{64}$/),
        dependencies: z.record(z.string(), z.string()),
        devDependencies: z.record(z.string(), z.string()),
        compiler: z.literal("CUDA 12.8.1 nvcc"),
        cudaArchDefault: z.string().min(1),
        dockerfileFlags: z
          .object({
            pinning: z.array(z.string()),
            historicalSubset: z.array(z.string()),
          })
          .strict(),
        defaultArchFlags: z
          .object({
            pinning: z.array(z.string()),
            historicalSubset: z.array(z.string()),
          })
          .strict(),
        images: z
          .object({ build: z.string().min(1), runtime: z.string().min(1) })
          .strict(),
        runpodPin: z.string().min(1),
        imageBuildStatus: z.literal("not-produced"),
      })
      .strict(),
    releases: z
      .object({
        pinning: z
          .object({
            role: z.literal("historical-pipeline-stage"),
            replacesSolverPipeline: z.literal(false),
            selectedByWorkerDockerfile: z.literal(true),
            compatiblePipelinePartner: z.literal("historicalSubset"),
            sourcesEnrolled: z.boolean(),
          })
          .strict(),
        historicalSubset: z
          .object({
            role: z.literal("historical-pipeline-stage"),
            replacesSolverPipeline: z.literal(false),
            selectedByWorkerDockerfile: z.literal(true),
            compatiblePipelinePartner: z.literal("pinning"),
            sourcesEnrolled: z.boolean(),
          })
          .strict(),
        optimizedSubset: z
          .object({
            role: z.literal("isolated-research"),
            replacesSolverPipeline: z.literal(false),
            selectedByWorkerDockerfile: z.literal(false),
            compatiblePipelinePartner: z.null(),
            sourcesEnrolled: z.boolean(),
            note: z.literal(
              "research/optimized-subset is not selected by worker/Dockerfile and is not a substitute for the pinning plus historical subset pipeline.",
            ),
          })
          .strict(),
      })
      .strict(),
    identities: z
      .object({
        sourceFiles: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
        components: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
        nativeBinaries: z
          .object({
            pinning: absentIdentitySchema,
            historicalSubset: absentIdentitySchema,
            optimizedSubset: absentIdentitySchema,
          })
          .strict(),
        imageConfig: absentIdentitySchema,
        ociIndex: absentIdentitySchema,
        registryManifest: absentIdentitySchema
          .extend({
            historicalPlaceholder: z.string().min(1),
            placeholderIsDeployable: z.literal(false),
          })
          .strict(),
      })
      .strict(),
    privateEvidence: z.array(z.string().min(1)).min(1),
  })
  .strict();

function readPackagedFile(treeRoot: string, relativePath: string): Buffer {
  if (relativePath.split("/").includes("..") || path.isAbsolute(relativePath))
    throw new Error("Release path escapes the checkout");
  const absolute = path.resolve(treeRoot, relativePath);
  if (!absolute.startsWith(treeRoot + path.sep))
    throw new Error("Release path escapes the checkout");
  return readFileSync(absolute);
}

function assertSourceDerivedFields(
  manifest: SourceReleaseManifest,
  treeRoot: string,
): void {
  const dockerfile = readPackagedFile(treeRoot, "worker/Dockerfile").toString("utf8");
  const built = parseWorkerDockerfile(dockerfile);
  const packageJson = JSON.parse(
    readPackagedFile(treeRoot, "package.json").toString("utf8"),
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const packageJsonSha256 = sha256Hex(readPackagedFile(treeRoot, "package.json"));
  const packageLockSha256 = sha256Hex(readPackagedFile(treeRoot, "package-lock.json"));
  const archivedRelease = JSON.parse(
    readPackagedFile(treeRoot, "src/lib/releases/qsb-config-a-ranked-v2.json").toString("utf8"),
  ) as { image: string };
  const expectedBuild = {
    node: ">=22" as const,
    nodeSource: "README.md" as const,
    packageJsonSha256,
    packageLockSha256,
    dependencies: packageJson.dependencies,
    devDependencies: packageJson.devDependencies,
    compiler: "CUDA 12.8.1 nvcc" as const,
    cudaArchDefault: built.cudaArch,
    dockerfileFlags: {
      pinning: built.pinningFlags,
      historicalSubset: built.subsetFlags,
    },
    defaultArchFlags: {
      pinning: expandArch(built.pinningFlags, built.cudaArch),
      historicalSubset: expandArch(built.subsetFlags, built.cudaArch),
    },
    images: { build: built.buildImage, runtime: built.runtimeImage },
    runpodPin: built.runpodPin,
    imageBuildStatus: "not-produced" as const,
  };
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${key}:${stable(record[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  if (stable(manifest.buildInputs) !== stable(expectedBuild))
    throw new Error("Packaged build inputs do not match the packaged sources");
  const pinningEnrolled = Object.keys(manifest.identities.sourceFiles).some((file) =>
    file.startsWith("vendor/challenge/candidates/pinning/"),
  );
  const subsetEnrolled = Object.keys(manifest.identities.sourceFiles).some((file) =>
    file.startsWith("vendor/challenge/candidates/subset/"),
  );
  const optimizedEnrolled = Object.keys(manifest.identities.sourceFiles).some((file) =>
    file.startsWith("research/optimized-subset/"),
  );
  if (
    manifest.releases.pinning.sourcesEnrolled !== pinningEnrolled ||
    manifest.releases.historicalSubset.sourcesEnrolled !== subsetEnrolled ||
    manifest.releases.optimizedSubset.sourcesEnrolled !== optimizedEnrolled ||
    manifest.identities.registryManifest.historicalPlaceholder !== archivedRelease.image
  )
    throw new Error("Packaged release metadata does not match the packaged sources");
}

export function verifyPackageTree(outDir: string): SourceReleaseManifest {
  const parsed = sourceReleaseManifestSchema.parse(
    JSON.parse(readFileSync(path.join(outDir, "release-manifest.json"), "utf8")),
  );
  const manifest = parsed as SourceReleaseManifest;
  if (manifest.format !== RELEASE_MANIFEST_FORMAT)
    throw new Error("Release manifest format is not enrolled");
  assertCompatibleStages(manifest);
  const absent = [
    manifest.identities.nativeBinaries.pinning,
    manifest.identities.nativeBinaries.historicalSubset,
    manifest.identities.nativeBinaries.optimizedSubset,
    manifest.identities.imageConfig,
    manifest.identities.ociIndex,
    manifest.identities.registryManifest,
  ];
  if (
    manifest.mainnetEnabled !== false ||
    manifest.broadcastAuthorized !== false ||
    manifest.identities.registryManifest.placeholderIsDeployable !== false ||
    absent.some((identity) => identity.value !== null || identity.status !== "not-produced")
  )
    throw new Error("Release manifest claims an identity this checkout did not produce");
  const treeRoot = path.resolve(outDir, "tree");
  const walked = walkFiles(treeRoot, ".", false);
  const enrolledPaths = Object.keys(manifest.identities.sourceFiles).sort();
  if (walked.join("\n") !== enrolledPaths.join("\n"))
    throw new Error("Packaged tree does not match the manifest path set");
  for (const [relativePath, digest] of Object.entries(
    manifest.identities.sourceFiles,
  )) {
    if (relativePath.split("/").includes("..") || path.isAbsolute(relativePath))
      throw new Error("Release path escapes the checkout");
    const absolute = path.resolve(treeRoot, relativePath);
    if (!absolute.startsWith(treeRoot + path.sep))
      throw new Error("Release path escapes the checkout");
    if (sha256Hex(readFileSync(absolute)) !== digest)
      throw new Error(`Packaged content does not match enrolled identity: ${relativePath}`);
  }
  const components = componentIdentities(manifest.identities.sourceFiles);
  const componentNames = [
    ...new Set([
      ...Object.keys(components),
      ...Object.keys(manifest.identities.components),
    ]),
  ].sort();
  for (const name of componentNames) {
    if (components[name] !== manifest.identities.components[name])
      throw new Error(`Packaged component does not match enrolled identity: ${name}`);
  }
  assertSourceDerivedFields(manifest, treeRoot);
  return manifest;
}
