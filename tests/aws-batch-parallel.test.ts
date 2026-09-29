import { expect, it, vi } from "vitest";
import command from "../server/aws-batch-command.json";
// With four GPUs per withdrawal, the compute environment must allow exactly four g5.xlarge.
vi.mock("../server/gpu-spend", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, gpuSpendLimits: { ...actual.gpuSpendLimits, workersMax: 4 } };
});
import { AwsBatch } from "../server/aws-batch";

const queue = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu";
const definition = "arn:aws:batch:eu-west-1:123456789012:job-definition/qsb-gpu-solver:1";
const image = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:" + "a".repeat(64);
function provider(maxvCpus: number) {
  const batch: any = {
    send: vi.fn(async (c: any) => {
      switch (c.constructor.name) {
        case "DescribeJobDefinitionsCommand":
          return {
            jobDefinitions: [{
              jobDefinitionArn: definition, status: "ACTIVE",
              containerProperties: {
                image, command, readonlyRootFilesystem: true, privileged: false,
                resourceRequirements: [{ type: "GPU", value: "1" }, { type: "VCPU", value: "4" }],
              },
              retryStrategy: { attempts: 1 }, timeout: { attemptDurationSeconds: 900 },
            }],
          };
        case "DescribeJobQueuesCommand":
          return { jobQueues: [{ jobQueueArn: queue, state: "ENABLED", status: "VALID", computeEnvironmentOrder: [{ computeEnvironment: "ce" }] }] };
        case "DescribeComputeEnvironmentsCommand":
          return { computeEnvironments: [{ state: "ENABLED", status: "VALID", computeResources: { type: "EC2", allocationStrategy: "BEST_FIT", minvCpus: 0, maxvCpus, instanceTypes: ["g5.xlarge"] } }] };
        default:
          return {};
      }
    }),
  };
  const s3: any = { send: vi.fn(async () => ({})) };
  return { aws: new AwsBatch(queue, definition, "qsb-gpu-jobs", batch, s3, batch), s3 };
}
it("accepts a compute environment sized to exactly one GPU instance per worker", async () => {
  const { aws } = provider(16);
  await expect(aws.prepareRun(image, { public: "fixture" })).resolves.toBeTypeOf("function");
});
it.each([4, 32])("refuses a compute environment of %i vCPUs before uploading anything", async (maxvCpus) => {
  const { aws, s3 } = provider(maxvCpus);
  await expect(aws.prepareRun(image, { public: "fixture" })).rejects.toThrow("ProviderLimitsUnconfirmed");
  expect(s3.send).not.toHaveBeenCalled();
});
