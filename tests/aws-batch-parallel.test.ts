import { expect, it, vi } from "vitest";
import command from "../server/aws-batch-command.json";
// The production pool reserves one largest-host allowance inside the 112-vCPU ceiling.
vi.mock("../server/gpu-spend", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, gpuSpendLimits: { ...actual.gpuSpendLimits, workersMax: 16 } };
});
import { AwsBatch } from "../server/aws-batch";

const queue = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu";
const definition = "arn:aws:batch:eu-west-1:123456789012:job-definition/qsb-gpu-solver:1";
const image = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:" + "a".repeat(64);
function provider(maxvCpus: number, instanceTypes = ["g5.xlarge", "g5.2xlarge", "g5.4xlarge"]) {
  const batch: any = {
    send: vi.fn(async (c: any) => {
      switch (c.constructor.name) {
        case "DescribeJobDefinitionsCommand":
          return {
            jobDefinitions: [{
              jobDefinitionArn: definition, status: "ACTIVE",
              containerProperties: {
      environment: [{ name: "QSB_JOB_BUCKET", value: "qsb-gpu-jobs" }],
                image, command, readonlyRootFilesystem: true, privileged: false,
                resourceRequirements: [{ type: "GPU", value: "1" }, { type: "VCPU", value: "4" }],
              },
              retryStrategy: { attempts: 1 }, timeout: { attemptDurationSeconds: 900 },
            }],
          };
        case "DescribeJobQueuesCommand":
          return { jobQueues: [{ jobQueueArn: queue, state: "ENABLED", status: "VALID", computeEnvironmentOrder: [{ computeEnvironment: "ce" }] }] };
        case "DescribeComputeEnvironmentsCommand":
          return { computeEnvironments: [{ state: "ENABLED", status: "VALID", computeResources: { type: "EC2", allocationStrategy: "BEST_FIT_PROGRESSIVE", minvCpus: 0, maxvCpus, instanceTypes } }] };
        default:
          return {};
      }
    }),
  };
  const s3: any = { send: vi.fn(async () => ({})) };
  return { aws: new AwsBatch(queue, definition, "qsb-gpu-jobs", batch, s3, batch), s3 };
}
it("accepts the fallback pool with a bounded worst-case overshoot", async () => {
  const { aws } = provider(96);
  await expect(aws.prepareRun(image, { public: "fixture" })).resolves.toBeTypeOf("function");
});
it.each([48, 64, 112, 128])("refuses a compute environment of %i vCPUs before uploading anything", async (maxvCpus) => {
  const { aws, s3 } = provider(maxvCpus);
  await expect(aws.prepareRun(image, { public: "fixture" })).rejects.toThrow("ProviderLimitsUnconfirmed");
  expect(s3.send).not.toHaveBeenCalled();
});


it("limits concurrent chunks to the largest allowed single-A10G host", () => {
  expect(provider(96).aws.parallelismLimit).toBe(6);
});

it.each([
  ["g5.xlarge"],
  ["g5.xlarge", "g5.2xlarge"],
  ["g5.xlarge", "g5.2xlarge", "g5.8xlarge"],
  ["g5.xlarge", "g5.2xlarge", "g5.4xlarge", "g5.4xlarge"],
])("rejects a different fallback host set %j before storing an input", async (...types) => {
  const { aws, s3 } = provider(96, types);
  await expect(aws.prepareRun(image, {})).rejects.toThrow("ProviderLimitsUnconfirmed");
  expect(s3.send).not.toHaveBeenCalled();
});

it("accepts the exact allowed set regardless of AWS response order", async () => {
  const { aws } = provider(96, ["g5.4xlarge", "g5.xlarge", "g5.2xlarge"]);
  await expect(aws.prepareRun(image, {})).resolves.toBeTypeOf("function");
});
