import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import command from "../server/aws-batch-command.json";
import { AwsBatch } from "../server/aws-batch";
const queue = "arn:aws:batch:eu-west-1:905846953990:job-queue/qsb-gpu";
const definition =
  "arn:aws:batch:eu-west-1:905846953990:job-definition/qsb-gpu-solver:1";
const image =
  "905846953990.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:" +
  "a".repeat(64);
const id = "11111111-1111-1111-1111-111111111111";
function setup() {
  const config: any = {
    jobDefinitionArn: definition,
    status: "ACTIVE",
    containerProperties: {
      image,
      command,
      readonlyRootFilesystem: true,
      privileged: false,
      resourceRequirements: [
        { type: "GPU", value: "1" },
        { type: "VCPU", value: "4" },
      ],
    },
    retryStrategy: { attempts: 1 },
    timeout: { attemptDurationSeconds: 900 },
  };
  const compute: any = {
    state: "ENABLED",
    status: "VALID",
    computeResources: {
      type: "EC2",
      allocationStrategy: "BEST_FIT",
      minvCpus: 0,
      maxvCpus: 4,
      instanceTypes: ["g5.xlarge"],
    },
  };
  const job: any = {
    jobId: id,
    jobQueue: queue,
    jobDefinition: definition,
    status: "RUNNING",
    container: {
      environment: [{ name: "QSB_INPUT_SHA256", value: "b".repeat(64) }],
    },
  };
  const submit = vi.fn(async (_input: any) => ({ jobId: id }));
  const batch: any = {
    send: vi.fn(async (c: any) => {
      switch (c.constructor.name) {
        case "DescribeJobDefinitionsCommand":
          return { jobDefinitions: [config] };
        case "DescribeJobQueuesCommand":
          return {
            jobQueues: [
              {
                jobQueueArn: queue,
                state: "ENABLED",
                status: "VALID",
                computeEnvironmentOrder: [{ computeEnvironment: "ce" }],
              },
            ],
          };
        case "DescribeComputeEnvironmentsCommand":
          return { computeEnvironments: [compute] };
        case "SubmitJobCommand":
          return submit(c.input);
        case "DescribeJobsCommand":
          return { jobs: [job] };
        default:
          return {};
      }
    }),
  };
  const s3: any = { send: vi.fn(async () => ({})) };
  return {
    provider: new AwsBatch(queue, definition, "qsb-gpu-jobs", batch, s3),
    config,
    compute,
    job,
    batch,
    s3,
    submit,
  };
}
it.each(["image", "retry", "size", "spot", "overrun", "caps"])(
  "fails closed before paid submission for %s",
  async (kind) => {
    const t = setup();
    if (kind === "caps") t.config.containerProperties.command = [];
    if (kind === "image") t.config.containerProperties.image += "wrong";
    if (kind === "retry") t.config.retryStrategy.attempts = 2;
    if (kind === "size") t.compute.computeResources.maxvCpus = 8;
    if (kind === "spot") t.compute.computeResources.type = "SPOT";
    if (kind === "overrun")
      t.compute.computeResources.allocationStrategy = "BEST_FIT_PROGRESSIVE";
    await expect(t.provider.prepareRun(image)).rejects.toThrow();
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.s3.send).not.toHaveBeenCalled();
  },
);
it("stores exact hashed input and submits once even when the acceptance response is lost", async () => {
  const t = setup(),
    run = await t.provider.prepareRun(image);
  t.submit.mockRejectedValueOnce(new Error("connection lost"));
  await expect(run({ public: "fixture" })).rejects.toThrow("connection lost");
  await expect(run({ public: "fixture" })).rejects.toThrow(
    "SubmissionAlreadyAttempted",
  );
  expect(t.submit).toHaveBeenCalledTimes(1);
  const request = t.submit.mock.calls[0][0] as any;
  const stored = t.s3.send.mock.calls[0][0].input;
  expect(stored.IfNoneMatch).toBe("*");
  expect(request.containerOverrides.environment).toContainEqual({
    name: "QSB_INPUT_SHA256",
    value: createHash("sha256").update(stored.Body).digest("hex"),
  });
  expect(request.retryStrategy).toEqual({ attempts: 1 });
  expect(request.timeout).toEqual({ attemptDurationSeconds: 900 });
});
it("rejects output for a different input and a different job definition", async () => {
  const t = setup();
  t.job.status = "SUCCEEDED";
  t.s3.send.mockResolvedValue({
    ContentLength: 200,
    Body: {
      transformToString: async () =>
        JSON.stringify({
          jobId: id,
          inputSha256: "c".repeat(64),
          executionTime: 1,
          output: {},
        }),
    },
  });
  await expect(t.provider.status(id)).rejects.toThrow(
    "ComputeOutputIdentityMismatch",
  );
  t.job.jobDefinition += "2";
  await expect(t.provider.status(id)).rejects.toThrow(
    "ProviderJobIdentityMismatch",
  );
});
it.each(["RUNNING", "STARTING", "RUNNABLE"])(
  "cancels %s through the matching Batch operation",
  async (status) => {
    const t = setup();
    t.job.status = status;
    await t.provider.cancel(id);
    expect(t.batch.send.mock.calls.at(-1)[0].constructor.name).toBe(
      status === "RUNNABLE" ? "CancelJobCommand" : "TerminateJobCommand",
    );
  },
);
