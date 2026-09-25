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
  if (!["mainnet", "testnet4"].includes(env.QSB_NETWORK!))
    return "QsbNetworkInvalid";
  if (env.QSB_NETWORK === "mainnet") {
    if (!env.QSB_MAINNET_ENABLED?.trim()) return "QsbMainnetEnabledRequired";
    if (!["true", "false"].includes(env.QSB_MAINNET_ENABLED))
      return "QsbMainnetEnabledInvalid";
  }
}
