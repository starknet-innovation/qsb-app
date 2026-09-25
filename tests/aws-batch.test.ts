import { BatchClient } from "@aws-sdk/client-batch";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import command from "../server/aws-batch-command.json";
import { AwsBatch } from "../server/aws-batch";
const transport = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("@aws-sdk/client-batch", async (original) => {
  const actual = await original<typeof import("@aws-sdk/client-batch")>();
  return {
    ...actual,
    BatchClient: class extends actual.BatchClient {
      constructor(config: any) {
        super({
          ...config,
          region: config.region ?? "eu-west-1",
          credentials: { accessKeyId: "test", secretAccessKey: "test" },
          requestHandler: { handle: transport.handle },
        });
      }
    },
  };
});
const queue = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu";
const definition =
  "arn:aws:batch:eu-west-1:123456789012:job-definition/qsb-gpu-solver:1";
const image =
  "123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:" +
  "a".repeat(64);
const id = "11111111-1111-1111-1111-111111111111";
function setup(realSubmit = false) {
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
    provider: new AwsBatch(
      queue,
      definition,
      "qsb-gpu-jobs",
      batch,
      s3,
      realSubmit ? undefined : batch,
    ),
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
    await expect(
      t.provider.prepareRun(image, { public: "fixture" }),
    ).rejects.toThrow();
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.s3.send).not.toHaveBeenCalled();
  },
);
it("stores exact hashed input and submits once even when the acceptance response is lost", async () => {
  const t = setup(),
    run = await t.provider.prepareRun(image, { public: "fixture" });
  t.submit.mockRejectedValueOnce(new Error("connection lost"));
  await expect(run()).rejects.toThrow("connection lost");
  await expect(run()).rejects.toThrow("SubmissionAlreadyAttempted");
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

it("uploads before producing a paid closure and exposes its durable identity", async () => {
  const t = setup();
  const run = await t.provider.prepareRun(image, { fixture: 1 });
  expect(t.submit).not.toHaveBeenCalled();
  const stored = t.s3.send.mock.calls[0][0].input;
  expect(run.identity).toEqual({
    queue,
    definition,
    jobName: "qsb-" + stored.Key.slice(7, -5),
    inputKey: stored.Key,
    inputSha256: createHash("sha256").update(stored.Body).digest("hex"),
  });
  t.s3.send.mockRejectedValueOnce(Error("S3 unavailable"));
  await expect(t.provider.prepareRun(image, {})).rejects.toThrow(
    "S3 unavailable",
  );
  expect(t.submit).not.toHaveBeenCalled();
});
it("binds queued and failed requests to their durable name, tags, input and definition", async () => {
  const t = setup(),
    run = await t.provider.prepareRun(image, {});
  const x = run.identity;
  Object.assign(t.job, {
    jobName: x.jobName,
    status: "FAILED",
    tags: {
      Project: "qsb-gpu",
      QsbRequest: x.jobName.slice(4),
      InputSha256: x.inputSha256,
    },
    container: {
      environment: [
        { name: "QSB_INPUT_SHA256", value: x.inputSha256 },
        { name: "QSB_INPUT_KEY", value: x.inputKey },
      ],
    },
  });
  expect(await t.provider.status(id, x)).toMatchObject({ status: "FAILED" });
  t.job.status = "RUNNABLE";
  expect(await t.provider.status(id, x)).toMatchObject({ status: "IN_QUEUE" });
  for (const field of [
    "jobName",
    "inputSha256",
    "inputKey",
    "queue",
    "definition",
  ] as const) {
    await expect(
      t.provider.status(id, { ...x, [field]: "wrong" }),
    ).rejects.toThrow("ProviderRequestIdentityMismatch");
  }
});

function httpResponse(statusCode: number, value: unknown) {
  return {
    response: {
      statusCode,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(value)),
    },
  };
}
it("the real SDK paid client performs exactly one HTTP attempt on a retryable 500", async () => {
  transport.handle.mockReset().mockResolvedValue(
    httpResponse(500, {
      __type: "ServerException",
      message: "lost acceptance response",
    }),
  );
  const t = setup(true),
    run = await t.provider.prepareRun(image, {});
  await expect(run()).rejects.toThrow();
  expect(transport.handle).toHaveBeenCalledTimes(1);
  await expect(run()).rejects.toThrow("SubmissionAlreadyAttempted");
  expect(transport.handle).toHaveBeenCalledTimes(1);
});
it("the real SDK read client recovers from one retryable 500 without submitting", async () => {
  const t = setup();
  transport.handle
    .mockReset()
    .mockResolvedValueOnce(
      httpResponse(500, { __type: "ServerException", message: "transient" }),
    )
    .mockResolvedValueOnce(httpResponse(200, { jobs: [t.job] }));
  const provider = new AwsBatch(queue, definition, "qsb-gpu-jobs");
  expect(await provider.status(id)).toMatchObject({ status: "IN_PROGRESS" });
  expect(transport.handle).toHaveBeenCalledTimes(2);
  expect(
    transport.handle.mock.calls.every(([request]) =>
      request.path.includes("describejobs"),
    ),
  ).toBe(true);
});
it("discovery scans all pages and never treats zero or multiple matches as rejection", async () => {
  const t = setup(),
    run = await t.provider.prepareRun(image, {}),
    identity = run.identity;
  t.batch.send
    .mockResolvedValueOnce({ jobSummaryList: [], nextToken: "page2" })
    .mockResolvedValueOnce({
      jobSummaryList: [{ jobId: id, jobName: identity.jobName }],
    });
  expect(await t.provider.findRequest(identity)).toBe(id);
  const calls = t.batch.send.mock.calls.slice(-2);
  expect(calls[0][0].input).toMatchObject({
    filters: [{ name: "JOB_NAME", values: [identity.jobName] }],
  });
  expect(calls[0][0].input.jobStatus).toBeUndefined();
  expect(calls[1][0].input.nextToken).toBe("page2");
  t.batch.send.mockResolvedValueOnce({ jobSummaryList: [] });
  expect(await t.provider.findRequest(identity)).toBeNull();
  t.batch.send.mockResolvedValueOnce({
    jobSummaryList: [
      { jobId: id, jobName: identity.jobName },
      { jobId: "other", jobName: identity.jobName },
    ],
  });
  await expect(t.provider.findRequest(identity)).rejects.toThrow(
    "BatchRequestNotUniquelyFound",
  );
  expect(t.submit).not.toHaveBeenCalled();
});

// The producer attests GHCR; deployment may mirror the exact manifest into ECR.
it("accepts the canonical producer digest mirrored into the queue account and region", async () => {
  const t = setup();
  const run = await t.provider.prepareRun(
    "ghcr.io/starknet-innovation/qsb-solver@sha256:" + "a".repeat(64),
    {},
  );
  expect(run.identity.queue).toBe(queue);
  expect(t.submit).not.toHaveBeenCalled();
});
it.each([
  "123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:" +
    "b".repeat(64),
  "000000000000.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:" +
    "a".repeat(64),
  "123456789012.dkr.ecr.us-east-1.amazonaws.com/qsb-solver@sha256:" +
    "a".repeat(64),
  "123456789012.dkr.ecr.eu-west-1.amazonaws.com/other@sha256:" + "a".repeat(64),
  "example.com/qsb-solver@sha256:" + "a".repeat(64),
  "123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver:latest",
])(
  "rejects an unbound deployment image before upload or paid submission: %s",
  async (deployed) => {
    const t = setup();
    t.config.containerProperties.image = deployed;
    await expect(
      t.provider.prepareRun(
        "ghcr.io/starknet-innovation/qsb-solver@sha256:" + "a".repeat(64),
        {},
      ),
    ).rejects.toThrow("ProviderImageUnconfirmed");
    expect(t.s3.send).not.toHaveBeenCalled();
    expect(t.submit).not.toHaveBeenCalled();
  },
);
it.each([
  "ghcr.io/other/qsb-solver@sha256:" + "a".repeat(64),
  "ghcr.io/starknet-innovation/qsb-solver:latest",
  "image:latest",
])("does not alias an unapproved producer image %s", async (enrolled) => {
  const t = setup();
  if (enrolled === "image:latest")
    t.config.containerProperties.image = enrolled;
  await expect(t.provider.prepareRun(enrolled, {})).rejects.toThrow(
    "ProviderImageUnconfirmed",
  );
  expect(t.s3.send).not.toHaveBeenCalled();
  expect(t.submit).not.toHaveBeenCalled();
});

it("drain checks every active Batch status and rejects malformed discovery", async () => {
  const t = setup();
  const original = t.batch.send.getMockImplementation()!;
  Object.setPrototypeOf(t.batch, BatchClient.prototype);
  const statuses: string[] = [];
  t.batch.send.mockImplementation(async (c: any) => {
    if (c.constructor.name !== "ListJobsCommand") return original(c);
    statuses.push(c.input.jobStatus);
    return {
      jobSummaryList: c.input.jobStatus === "PENDING" ? [{ jobId: id }] : [],
    };
  });
  expect((await t.provider.health()).jobs).toEqual({
    inQueue: 1,
    inProgress: 0,
  });
  expect(statuses).toEqual([
    "SUBMITTED",
    "PENDING",
    "RUNNABLE",
    "STARTING",
    "RUNNING",
  ]);
  t.batch.send.mockImplementation(async (c: any) =>
    c.constructor.name === "ListJobsCommand" ? {} : original(c),
  );
  await expect(t.provider.health()).rejects.toThrow("ProviderListInvalid");
  const prepared = await t.provider.prepareRun(image, {});
  await expect(t.provider.findRequest(prepared.identity)).rejects.toThrow(
    "ProviderListInvalid",
  );
});
