/** Validate a saved remote result locally; no provider calls or durable credit. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeResearchQueueCompletion } from "./pin_store";
import { createPinVerifier } from "./pin_verifier";

const [inputFile, resultFile, contextFile, runtimeManifestFile, outFile] =
  process.argv.slice(2);
if (
  !inputFile ||
  !resultFile ||
  !contextFile ||
  !runtimeManifestFile ||
  !outFile ||
  process.argv.length !== 7
)
  throw Error(
    "Expected input, result, public context, enrolled runtime manifest and new output paths",
  );
const read = (name: string) => JSON.parse(readFileSync(name, "utf8"));
const input = read(inputFile),
  provider = read(resultFile),
  context = read(contextFile);
const manifestBytes = readFileSync(runtimeManifestFile);
const runtime = JSON.parse(manifestBytes.toString("utf8"));
const digest = createHash("sha256").update(manifestBytes).digest("hex");
if (
  input.runtimeManifestSha256 !== digest ||
  runtime.format !== "qsb-yukon-pin-runtime-v1" ||
  runtime.releaseStatus !== "HOLD" ||
  runtime.dispatchAuthorized !== false
)
  throw Error("Unbound research runtime manifest");
const decoded = decodeResearchQueueCompletion(provider, input.request, digest);
const verdict = await createPinVerifier()(
  input.request,
  decoded.output,
  context,
  runtime.files["bin/pinning"],
);
writeFileSync(
  outFile,
  JSON.stringify(
    {
      providerJobId: provider.id,
      runtimeManifestSha256: digest,
      verdict,
      remoteQueueCompleted: true,
      imageAttested: false,
      rangeCreditGranted: false,
      freshWithdrawal: false,
      releaseStatus: "HOLD",
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
