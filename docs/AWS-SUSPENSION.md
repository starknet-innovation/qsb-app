# Suspending the AWS deployments

`scripts/suspend-aws.py` uses AWS CLI credentials to find resources tagged
`Application=qsb-vault`. It sets reserved Lambda concurrency to zero, disables
the direct API Gateway endpoints and CloudFront distributions, and stops any
running tagged Step Functions executions. It preserves persisted data and
deployment resources. It does not control external compute providers.

Before applying, confirm the account and region, check for scheduled triggers,
event-source mappings, other compute and provisioned concurrency. Commit and
push this script before execution. Use a clean checkout of that commit.

Run with `--profile`, `--region`, `--account` and `--snapshot` (an absolute path
outside Git). Without `--apply` this only writes a preflight snapshot. Use a
different snapshot path for the apply run. Runtime identifiers and snapshots
must not be committed. The script refuses to overwrite an existing snapshot.

Verify reserved concurrency is zero for every function, direct API endpoints
are disabled, CloudFront is disabled with status `Deployed`, and no workflow
executions or EC2 instances remain running. Confirm the websites no longer
serve the application. Lambda state can still read `Active` while all new
invocations are blocked by reserved concurrency zero.

This is an operational suspension and introduces drift from CloudFormation.
A later stack deployment may re-enable resources. Keep deployments paused
until an operator deliberately resumes them. Storage and other retained
resources may continue to incur charges.

To resume after authorization, restore the recorded Lambda reserved concurrency
(delete its reservation if absent in the snapshot), API endpoint flags, and
CloudFront configuration. Fetch a fresh CloudFront ETag before restoring the
configuration. Do not restart historical workflow executions automatically.
