import { afterEach, expect, it, vi } from "vitest";
import { AwsBatch } from "../server/aws-batch";
import validation from "../server/aws-batch-validation.json";
import command from "../server/aws-batch-command.json";

const campaign = "qsb-pqb-v-012345abcdef";
const queue = "arn:aws:batch:eu-west-2:123456789012:job-queue/qsb-gpu-validation";
const ce = queue.replace(":job-queue/", ":compute-environment/");
const definition = "arn:aws:batch:eu-west-2:123456789012:job-definition/qsb-gpu-solver:3";
const image = "ghcr.io/starknet-innovation/qsb-solver@sha256:" + "a".repeat(64);

function setup(selectedQueue = queue) {
  const q: any = { jobQueueArn: selectedQueue, state: "ENABLED", status: "VALID",
    tags: { Project: "qsb-gpu", PqbValidation: campaign }, computeEnvironmentOrder: [{ order: 1, computeEnvironment: ce }] };
  const e: any = { computeEnvironmentArn: ce, state: "ENABLED", status: "VALID",
    tags: { Project: "qsb-gpu", PqbValidation: campaign }, computeResources: {
      type: "EC2", allocationStrategy: "BEST_FIT_PROGRESSIVE", minvCpus: 0, maxvCpus: 64, instanceTypes: [validation.instanceType] } };
  const d: any = { jobDefinitionArn: definition, status: "ACTIVE", retryStrategy: { attempts: 1 }, timeout: { attemptDurationSeconds: 900 },
    containerProperties: { image, command, readonlyRootFilesystem: true, privileged: false,
      resourceRequirements: [{ type: "GPU", value: "1" }, { type: "VCPU", value: "4" }] } };
  const submit = vi.fn(async () => ({ jobId: "public-native-job" }));
  const batch: any = { send: vi.fn(async (c: any) => {
    if (c.constructor.name === "DescribeJobDefinitionsCommand") return { jobDefinitions: [d] };
    if (c.constructor.name === "DescribeJobQueuesCommand") return { jobQueues: [q] };
    if (c.constructor.name === "DescribeComputeEnvironmentsCommand") return { computeEnvironments: [e] };
    if (c.constructor.name === "SubmitJobCommand") return submit();
    throw Error("Unexpected Batch operation");
  }) };
  const s3: any = { send: vi.fn(async () => ({})) };
  vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", campaign + "-coordinator");
  return { provider: new AwsBatch(selectedQueue, definition, "qsb-gpu-jobs", batch, s3, batch), q, e, s3, submit };
}
afterEach(() => vi.unstubAllEnvs());

it("prepares the owned isolated L4 pool through the real provider with a sixteen-slot limit", async () => {
  const t = setup();
  expect(t.provider.parallelismLimit).toBe(16);
  const run = await t.provider.prepareRun(image, { public: "synthetic" });
  expect(run.identity.queue).toBe(queue);
  expect(t.submit).not.toHaveBeenCalled();
  await expect(run()).resolves.toEqual({ id: "public-native-job" });
  await expect(run()).rejects.toThrow("SubmissionAlreadyAttempted");
  expect(t.submit).toHaveBeenCalledTimes(1);
});

it.each(["production-function", "missing-function", "wrong-owner", "wrong-pool", "over-capacity", "mixed-types", "wrong-type", "wrong-strategy", "second-pool"])(
  "rejects %s before storing input or paying for work", async (kind) => {
    const t = setup();
    if (kind === "production-function") vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "qsb-app-coordinator");
    if (kind === "missing-function") vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", undefined);
    if (kind === "wrong-owner") t.e.tags.PqbValidation = "qsb-pqb-v-ffffffffffff";
    if (kind === "wrong-pool") t.q.computeEnvironmentOrder[0].computeEnvironment = ce + "-other";
    if (kind === "over-capacity") t.e.computeResources.maxvCpus = 128;
    if (kind === "wrong-type") t.e.computeResources.instanceTypes = ["g5.2xlarge"];
    if (kind === "mixed-types") t.e.computeResources.instanceTypes.push("g5.xlarge");
    if (kind === "wrong-strategy") t.e.computeResources.allocationStrategy = "BEST_FIT";
    if (kind === "second-pool") t.q.computeEnvironmentOrder.push({ order: 2, computeEnvironment: "other" });
    await expect(t.provider.prepareRun(image, { public: "synthetic" })).rejects.toThrow("ProviderLimitsUnconfirmed");
    expect(t.s3.send).not.toHaveBeenCalled(); expect(t.submit).not.toHaveBeenCalled();
  },
);

it("keeps the production queue's original hardware checks", async () => {
  const t = setup(queue.replace("qsb-gpu-validation", "qsb-gpu"));
  await expect(t.provider.prepareRun(image, { public: "synthetic" })).rejects.toThrow("ProviderLimitsUnconfirmed");
  expect(t.s3.send).not.toHaveBeenCalled(); expect(t.submit).not.toHaveBeenCalled();
});
