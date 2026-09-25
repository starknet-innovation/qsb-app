import { createHash, randomUUID } from "node:crypto";
import {
  BatchClient,
  DescribeJobDefinitionsCommand,
  DescribeJobQueuesCommand,
  DescribeComputeEnvironmentsCommand,
  SubmitJobCommand,
  DescribeJobsCommand,
  TerminateJobCommand,
  CancelJobCommand,
  paginateListJobs,
} from "@aws-sdk/client-batch";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import command from "./aws-batch-command.json";
import { gpuSpendLimits } from "./gpu-spend";
export type ComputeStatus = {
  id: string;
  status:
    | "IN_QUEUE"
    | "IN_PROGRESS"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED"
    | "TIMED_OUT";
  executionTime?: number;
  output?: unknown;
};
export interface ComputeProvider {
  health(): Promise<unknown>;
  prepareRun(
    image: string,
  ): Promise<(input: unknown) => Promise<{ id: string }>>;
  status(id: string): Promise<ComputeStatus>;
  cancel(id: string): Promise<unknown>;
}
export class AwsBatch implements ComputeProvider {
  constructor(
    private queue: string,
    private definition: string,
    private bucket: string,
    private batch = new BatchClient({
      region: process.env.AWS_REGION,
      maxAttempts: 1,
    }),
    private s3 = new S3Client({
      region: process.env.AWS_REGION,
      maxAttempts: 1,
    }),
  ) {
    if (
      !/^arn:aws:batch:[a-z0-9-]+:\d{12}:job-queue\/qsb-[\w-]+$/.test(queue) ||
      !/^arn:aws:batch:[a-z0-9-]+:\d{12}:job-definition\/qsb-[\w-]+:\d+$/.test(
        definition,
      ) ||
      !/^qsb-[a-z0-9-]+$/.test(bucket)
    )
      throw new Error("ComputeConfigurationRequired");
  }
  async health() {
    const queues = await this.batch.send(
      new DescribeJobQueuesCommand({ jobQueues: [this.queue] }),
    );
    let inQueue = 0,
      inProgress = 0;
    for (const status of [
      "SUBMITTED",
      "PENDING",
      "RUNNABLE",
      "STARTING",
      "RUNNING",
    ] as const) {
      for await (const page of paginateListJobs(
        { client: this.batch },
        { jobQueue: this.queue, jobStatus: status },
      )) {
        if (status === "RUNNING")
          inProgress += page.jobSummaryList?.length || 0;
        else inQueue += page.jobSummaryList?.length || 0;
      }
    }
    return {
      provider: "aws-batch",
      jobs: { inQueue, inProgress },
      queues: queues.jobQueues?.map((q) => ({
        arn: q.jobQueueArn,
        state: q.state,
        status: q.status,
      })),
    };
  }
  async prepareRun(image: string) {
    const [definitions, queues] = await Promise.all([
      this.batch.send(
        new DescribeJobDefinitionsCommand({
          jobDefinitions: [this.definition],
        }),
      ),
      this.batch.send(
        new DescribeJobQueuesCommand({ jobQueues: [this.queue] }),
      ),
    ]);
    const d = definitions.jobDefinitions?.[0],
      q = queues.jobQueues?.[0];
    if (
      definitions.jobDefinitions?.length !== 1 ||
      d?.jobDefinitionArn !== this.definition ||
      d.status !== "ACTIVE" ||
      d.containerProperties?.image !== image
    )
      throw new Error("ProviderImageUnconfirmed");
    const resources = d.containerProperties?.resourceRequirements;
    if (
      d.containerProperties?.readonlyRootFilesystem !== true ||
      d.containerProperties?.privileged !== false ||
      JSON.stringify(d.containerProperties?.command) !==
        JSON.stringify(command) ||
      d.retryStrategy?.attempts !== 1 ||
      d.timeout?.attemptDurationSeconds !==
        gpuSpendLimits.executionTimeoutMs / 1000 ||
      resources?.find((r) => r.type === "GPU")?.value !== "1" ||
      resources.find((r) => r.type === "VCPU")?.value !== "4" ||
      queues.jobQueues?.length !== 1 ||
      q?.jobQueueArn !== this.queue ||
      q.state !== "ENABLED" ||
      q.status !== "VALID" ||
      q.computeEnvironmentOrder?.length !== 1
    )
      throw new Error("ProviderLimitsUnconfirmed");
    const env = await this.batch.send(
      new DescribeComputeEnvironmentsCommand({
        computeEnvironments: [q.computeEnvironmentOrder[0].computeEnvironment!],
      }),
    );
    const e = env.computeEnvironments?.[0],
      c = e?.computeResources;
    if (
      e?.state !== "ENABLED" ||
      e.status !== "VALID" ||
      c?.type !== "EC2" ||
      c.allocationStrategy !== "BEST_FIT" ||
      c.minvCpus !== 0 ||
      c.maxvCpus !== 4 ||
      c.instanceTypes?.length !== 1 ||
      c.instanceTypes[0] !== "g5.xlarge"
    )
      throw new Error("ProviderLimitsUnconfirmed");
    let consumed = false;
    return async (input: unknown) => {
      if (consumed) throw new Error("SubmissionAlreadyAttempted");
      consumed = true;
      const body = JSON.stringify({ input });
      if (Buffer.byteLength(body) > 150000)
        throw new Error("ComputeInputTooLarge");
      const digest = createHash("sha256").update(body).digest("hex"),
        token = randomUUID(),
        key = `inputs/${token}.json`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
          IfNoneMatch: "*",
        }),
      );
      // SubmitJob has no idempotency token: disable SDK retries and never replay.
      const r = await this.batch.send(
        new SubmitJobCommand({
          jobName: `qsb-${token}`,
          jobQueue: this.queue,
          jobDefinition: this.definition,
          retryStrategy: { attempts: 1 },
          timeout: {
            attemptDurationSeconds: gpuSpendLimits.executionTimeoutMs / 1000,
          },
          containerOverrides: {
            environment: [
              { name: "QSB_INPUT_KEY", value: key },
              { name: "QSB_INPUT_SHA256", value: digest },
            ],
          },
          tags: { Project: "qsb-gpu", QsbRequest: token, InputSha256: digest },
        }),
      );
      if (!r.jobId) throw new Error("SubmissionOutcomeUnknown");
      return { id: r.jobId };
    };
  }
  private async describe(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("InvalidBatchJobId");
    const r = await this.batch.send(new DescribeJobsCommand({ jobs: [id] })),
      j = r.jobs?.[0];
    if (
      r.jobs?.length !== 1 ||
      j?.jobId !== id ||
      j.jobQueue !== this.queue ||
      j.jobDefinition !== this.definition
    )
      throw new Error("ProviderJobIdentityMismatch");
    return j;
  }
  async status(id: string): Promise<ComputeStatus> {
    const j = await this.describe(id);
    if (j.status === "SUCCEEDED") {
      const r = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: `outputs/${id}.json`,
        }),
      );
      if (!r.Body) throw new Error("ComputeOutputMissing");
      if (r.ContentLength === undefined || r.ContentLength > 600000) {
        (r.Body as any).destroy?.();
        throw new Error("ComputeOutputTooLarge");
      }
      const raw = await r.Body.transformToString();
      if (Buffer.byteLength(raw) > 600000)
        throw new Error("ComputeOutputTooLarge");
      const output = z
        .object({
          jobId: z.literal(id),
          inputSha256: z.string(),
          executionTime: z.number().nonnegative(),
          output: z.unknown(),
        })
        .strict()
        .parse(JSON.parse(raw));
      const digest = j.container?.environment?.find(
        (e) => e.name === "QSB_INPUT_SHA256",
      )?.value;
      if (!digest || output.inputSha256 !== digest)
        throw new Error("ComputeOutputIdentityMismatch");
      return {
        id,
        status: "COMPLETED",
        executionTime: output.executionTime,
        output: output.output,
      };
    }
    if (j.status === "FAILED") return { id, status: "FAILED" };
    if (j.status === "RUNNING") return { id, status: "IN_PROGRESS" };
    if (
      !["SUBMITTED", "PENDING", "RUNNABLE", "STARTING"].includes(j.status || "")
    )
      throw new Error("ProviderStatusInvalid");
    return { id, status: "IN_QUEUE" };
  }
  async cancel(id: string) {
    const j = await this.describe(id);
    if (["SUCCEEDED", "FAILED"].includes(j.status || "")) return;
    const request = {
      jobId: id,
      reason: "QSB operator/coordinator cancellation",
    };
    return this.batch.send(
      ["RUNNING", "STARTING"].includes(j.status || "")
        ? new TerminateJobCommand(request)
        : new CancelJobCommand(request),
    );
  }
}
