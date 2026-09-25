import { createHash, randomUUID } from "node:crypto";
import {
  BatchClient,
  ListJobsCommand,
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
import type { BatchSubmissionIdentity } from "../src/lib/model";
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
export type PreparedRun = (() => Promise<{ id: string }>) & {
  identity: BatchSubmissionIdentity;
};
export interface ComputeProvider {
  health(): Promise<unknown>;
  prepareRun(image: string, input: unknown): Promise<PreparedRun>;
  status(
    id: string,
    identity?: BatchSubmissionIdentity,
  ): Promise<ComputeStatus>;
  cancel(id: string): Promise<unknown>;
}
export class AwsBatch implements ComputeProvider {
  constructor(
    private queue: string,
    private definition: string,
    private bucket: string,
    private batch = new BatchClient({
      region: process.env.AWS_REGION,
      maxAttempts: 3,
    }),
    private s3 = new S3Client({
      region: process.env.AWS_REGION,
      maxAttempts: 3,
    }),
    private submitClient = new BatchClient({
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
      { abortSignal: AbortSignal.timeout(20000) },
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
        { abortSignal: AbortSignal.timeout(20000) },
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
  async prepareRun(image: string, input: unknown) {
    const [definitions, queues] = await Promise.all([
      this.batch.send(
        new DescribeJobDefinitionsCommand({
          jobDefinitions: [this.definition],
        }),
        { abortSignal: AbortSignal.timeout(20000) },
      ),
      this.batch.send(
        new DescribeJobQueuesCommand({ jobQueues: [this.queue] }),
        { abortSignal: AbortSignal.timeout(20000) },
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
      { abortSignal: AbortSignal.timeout(20000) },
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
      { abortSignal: AbortSignal.timeout(20000) },
    );
    const identity: BatchSubmissionIdentity = {
      jobName: `qsb-${token}`,
      inputSha256: digest,
      inputKey: key,
      queue: this.queue,
      definition: this.definition,
    };
    let consumed = false;
    const submit = async () => {
      if (consumed) throw new Error("SubmissionAlreadyAttempted");
      consumed = true;
      // SubmitJob has no idempotency token: disable SDK retries and never replay.
      const r = await this.submitClient.send(
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
        { abortSignal: AbortSignal.timeout(20000) },
      );
      if (!r.jobId) throw new Error("SubmissionOutcomeUnknown");
      return { id: r.jobId };
    };
    return Object.assign(submit, { identity });
  }
  /** Discovery is positive evidence only: absence never authorizes a replacement. */
  async findRequest(identity: BatchSubmissionIdentity): Promise<string> {
    if (
      identity.queue !== this.queue ||
      identity.definition !== this.definition ||
      !/^qsb-[a-f0-9-]{36}$/.test(identity.jobName)
    )
      throw new Error("ProviderRequestIdentityMismatch");
    const ids = new Set<string>();
    let nextToken: string | undefined;
    const abortSignal = AbortSignal.timeout(20000);
    do {
      const page = await this.batch.send(
        new ListJobsCommand({
          jobQueue: this.queue,
          filters: [{ name: "JOB_NAME", values: [identity.jobName] }],
          nextToken,
        }),
        { abortSignal },
      );
      for (const j of page.jobSummaryList ?? []) {
        if (j.jobName === identity.jobName && j.jobId) ids.add(j.jobId);
      }
      nextToken = page.nextToken;
    } while (nextToken);
    if (ids.size !== 1) throw new Error("BatchRequestNotUniquelyFound");
    return [...ids][0];
  }
  private async describe(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("InvalidBatchJobId");
    const r = await this.batch.send(new DescribeJobsCommand({ jobs: [id] }), {
        abortSignal: AbortSignal.timeout(20000),
      }),
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
  async status(
    id: string,
    identity?: BatchSubmissionIdentity,
  ): Promise<ComputeStatus> {
    const j = await this.describe(id);
    if (
      identity &&
      (identity.queue !== this.queue ||
        identity.definition !== this.definition ||
        j.jobName !== identity.jobName ||
        j.tags?.Project !== "qsb-gpu" ||
        j.tags?.QsbRequest !== identity.jobName.slice(4) ||
        j.tags?.InputSha256 !== identity.inputSha256 ||
        j.container?.environment?.find((e) => e.name === "QSB_INPUT_KEY")
          ?.value !== identity.inputKey ||
        j.container?.environment?.find((e) => e.name === "QSB_INPUT_SHA256")
          ?.value !== identity.inputSha256)
    )
      throw new Error("ProviderRequestIdentityMismatch");
    if (j.status === "SUCCEEDED") {
      const r = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: `outputs/${id}.json`,
        }),
        { abortSignal: AbortSignal.timeout(20000) },
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
