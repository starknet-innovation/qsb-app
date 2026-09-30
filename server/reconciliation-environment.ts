/** Import-safe CLI preflight: no application configuration, SDK or store imports. */
export function reconciliationEnvironmentError(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const required = {
    TABLE_NAME: "TableNameRequired",
    AWS_REGION: "AwsRegionRequired",
    AWS_BATCH_JOB_QUEUE: "BatchQueueRequired",
    AWS_BATCH_JOB_DEFINITION: "BatchDefinitionRequired",
    AWS_BATCH_JOB_BUCKET: "BatchBucketRequired",
    WORKFLOW_ARN: "WorkflowArnRequired",
    QSB_NETWORK: "QsbNetworkRequired",
  };
  for (const [name, reason] of Object.entries(required))
    if (!env[name]?.trim()) return reason;
  if (env.QSB_NETWORK !== "mainnet") return "QsbNetworkInvalid";
  if (!env.QSB_MAINNET_ENABLED?.trim()) return "QsbMainnetEnabledRequired";
  if (!["true", "false"].includes(env.QSB_MAINNET_ENABLED))
    return "QsbMainnetEnabledInvalid";
  // A shell that lost the setting must not skip the deployment's slot limit.
  if (!env.QSB_OWNER_MAX_ACTIVE_JOBS?.trim()) return "OwnerMaxActiveJobsRequired";
  if (reconcileActiveJobLimit(env) === undefined) return "OwnerMaxActiveJobsInvalid";
}

/**
 * The deployment's QSB_OWNER_MAX_ACTIVE_JOBS as the reconcile CLI must be given it: a positive
 * integer, or the literal `off` (null) that only this CLI accepts. Undefined when missing or malformed.
 */
export function reconcileActiveJobLimit(env: NodeJS.ProcessEnv): number | null | undefined {
  const value = env.QSB_OWNER_MAX_ACTIVE_JOBS;
  if (value === "off") return null;
  if (value === undefined || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    return undefined;
  return Number(value);
}
