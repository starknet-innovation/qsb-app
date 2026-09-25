import { AwsBatch } from "./aws-batch";
export function computeConfigured() {
  return Boolean(
    process.env.AWS_BATCH_JOB_QUEUE &&
    process.env.AWS_BATCH_JOB_DEFINITION &&
    process.env.AWS_BATCH_JOB_BUCKET,
  );
}
export async function configuredCompute() {
  if (!computeConfigured()) throw new Error("ComputeConfigurationRequired");
  return new AwsBatch(
    process.env.AWS_BATCH_JOB_QUEUE!,
    process.env.AWS_BATCH_JOB_DEFINITION!,
    process.env.AWS_BATCH_JOB_BUCKET!,
  );
}
