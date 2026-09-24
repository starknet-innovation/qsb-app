# Supervised runtime infrastructure

This folder describes the long-running CPU supervisor while leaving GPUs on Runpod. It is **not** the mainnet job path. `network = "mainnet"` rejects `provision_runtime = true`. Mainnet jobs are created by `createApp`, started with `startWorkflow`, and run by the Step Functions coordinator. See [mainnet pipeline](../../docs/MAINNET-PIPELINE.md).

## What is provisioned

| Boundary | Implementation |
| --- | --- |
| Linux supervisor host | One pinned x86_64 EC2 CPU instance; private subnet, no public IP or inbound ports, IMDSv2, encrypted root volume, termination protection; SSM access |
| External connectivity | Dedicated VPC, public/private subnets, internet gateway and a NAT gateway for outbound HTTPS to AWS/Runpod/registry |
| Evidence | Separate encrypted gp3 EBS mounted at `/evidence`, retained across host removal; daily AWS Backup snapshots retained 30 days |
| Durable archives/artifacts | Private encrypted versioned S3 bucket with `releases/` and `evidence/` prefixes; immutable-tag ECR repository for reviewed images |
| Dispatch transport | Encrypted FIFO SQS queue and dead-letter queue, three delivery attempts before dead-lettering, API send permission and host receive permission |
| Authority | Separate host IAM role; exact application-table scope; no provider secret-read permission on the host; no cleanup table mutation from host/API |
| Independent cleanup | Scheduled Lambda outside the host/VPC, explicit endpoint/deadline allowlist, private runtime secret resolution, append-only cleanup observations in a separate protected DynamoDB table |
| Monitoring | Host status, dispatch dead-letter and cleanup-error alarms in addition to existing application alarms; SNS destinations remain operator-configured |

No automatic host replacement/ASG is configured: replacement must reconcile process ownership, Docker engine identity, pending work and evidence. EBS and its host use the same explicit AZ. The provisioned network is single-AZ and is not an HA design. EC2, NAT, public IPv4, EBS, backup, S3, Lambda/logs and queue usage can incur costs even with no GPU jobs; review the plan and your regional prices.

## Configure a dormant host

Do not use these settings for a mainnet environment. `network = "mainnet"` rejects `provision_runtime`.

Add these non-secret settings to your ignored `terraform.tfvars` only for a non-mainnet plan:

```hcl
provision_runtime         = true
runtime_ami_id            = "ami-REPLACE_WITH_REVIEWED_IMAGE"
runtime_ami_owner         = "123456789012"
runtime_availability_zone = "eu-west-1a"
runtime_instance_type     = "m6i.large"
runtime_evidence_gib      = 50
cleanup_endpoints         = {}
```

Use a pinned **reviewed AMI you own or trust**, with x86_64 Linux/systemd, SSM agent, Docker, Node.js 22, Python 3, NVMe persistent volume identifiers and ext4 utilities. Runtime paths require `/usr/local/bin/node`, `/usr/local/bin/python` and the Docker CLI. Terraform verifies AMI ID/owner/architecture but does not certify its contents. No moving `latest` AMI or downloaded root setup script is used.

The bootstrap waits up to ten minutes for the exact attached Nitro EBS volume, initializes it only if no filesystem/signature exists, rejects an unexpected filesystem or occupied mountpoint, and verifies the mounted UUID. Existing evidence is not reformatted. Failure leaves execution disabled and must be investigated through SSM/cloud-init. Do not mount the same evidence volume into another active controller.

Build, commit/push and plan/apply as in the [parent guide](../README.md). `terraform output supervised_runtime` provides the instance, queue, bucket, volume and registry identifiers. The AMI itself is an operator-supplied build artifact, like the reviewed CPU/Runpod images; this folder does not manufacture an unvalidated runtime image.

## Software installation and activation boundary

The application-to-dispatch source connection and packaged one-shot host consumer are implemented; see [dispatcher contract and tests](../../supervised/README.md). Terraform also packages a disabled outbox publisher. No queue consumer is started automatically. Live runtime installation and enrollment remain unfinished:

1. Publish the independently reviewed, self-contained API/dispatcher and normal sealed runtime distribution under immutable source/image identities. Preserve third-party licenses and exclude all fixture/runtime credentials.
2. Install protected read-only runtime code at `/source`, the reviewed dispatcher at `/opt/qsb/dispatcher/dispatcher.cjs`, and preload exact CPU images into the host's Docker engine. A new ECR location requires explicit identity/permission enrollment; it does not inherit the old registry attestation.
3. Bind the trusted dispatcher to the provisioned queue and table. Queue messages identify an existing immutable queued job; the consumer must reread authority, claim before spawn, preserve unknown outcomes and reject changed identity. SQS deduplication alone is not a paid-submission guarantee. DLQ redrive is an operator reconciliation decision, never a blind retry.
4. Bind actual evidence readers to protected host directories/current session lineage and publish only verified public results to the API. The bucket is provisioned but no speculative evidence-upload daemon is installed; the reviewed exporter must upload public-only journals.
5. Supply provider authentication privately through the reviewed inherited FIFO interface. Never put a key in SQS, EC2 user data, Terraform state, SSM command parameters or public configuration. The host role intentionally cannot fetch the provider secret; the cleanup Lambda's separately scoped access does not change that boundary.
6. Enroll and test the existing runtime's exact per-endpoint watchdog/acknowledgement contract before permitting paid work. The independent Lambda below is an additional cleanup boundary; it does not satisfy a local watchdog-socket check or authorize a submission by itself.
7. Validate the selected host lifecycle, restore procedure, complete signing flow and required fresh proof. Record the clean pushed commit and exact deployments. Only then review a separate activation change; unmasking services alone is not release approval.

`qsb-host-preflight` is installed as a **read-only diagnostic**. It checks Linux/architecture, paths, evidence mount and presence of package/dispatcher. It reports `launchAuthorized:false` even on success. Presence checks are not artifact attestation. This is intentionally not a shell script that downloads code and starts a paid search.

## Explicit endpoint cleanup enrollment

The watchdog makes real deletion requests only after an operator configures `cleanup_endpoints`, provides the existing Runpod secret ARN (and matching base compute configuration), reviews the changed plan and applies it. Use only newly owned, disposable endpoints whose deletion is specifically authorized. Never enroll a shared endpoint or an old completed proof endpoint.

```hcl
cleanup_endpoints = {
  # Replace with a real disposable endpoint only after reviewing deletion authority.
  exampleendpoint = { delete_after = "2026-09-24T20:00:00Z" }
}
```

Dates above are examples, not valid future launch instructions. Set a concrete deadline at or before the authorized GPU cutoff. The empty map keeps the schedule disabled. Removing an enrollment or extending a deadline changes safety behavior and requires review, never automatic renewal by the worker.

The Lambda runs once per minute independently of the host. After a durable intent record it GETs the fixed control-plane endpoint, DELETEs a present endpoint, then GETs again to confirm absence. A 404 before deletion is recorded as already absent, not a fabricated successful delete. Authorization/server errors or unconfirmed absence record an unresolved result and trigger an error alarm. Observations never grant range credit, spend authority or job-drain certification. Subsequent scheduled attempts reconcile the same explicitly enrolled endpoint; no billable submission is retried.

This uses Runpod's documented [endpoint delete control API](https://docs.runpod.io/api-reference/endpoints/DELETE/endpoints/endpointId), not the serverless job invocation URL. The independently scheduled cleanup is best-effort: scheduler latency, credential expiry, provider outage and AWS failure can delay deletion. It is **not a hard billing cap**. Provider-side execution/idle TTLs and independently tested operator cleanup are still required. Logs do not include credential values or raw provider response bodies.

## Data protection and recovery

- Do not delete/detach the evidence volume or replace the host before reconciling actual processes and provider IDs. Protection intentionally blocks routine Terraform destruction/replacement until an operator reviews it.
- Daily snapshots are crash-consistent recovery aids, not proof of application-level drain or preservation of every last write. Test restore onto an isolated host before relying on them.
- S3 versioning preserves overwritten objects, but is not Object Lock/WORM protection. Upload only public recovery/search evidence; never a wallet backup or passphrase.
- Database one-time commitment authority and legacy-writer exclusion still require the migration/IAM gates in the readiness checklist. Provisioning another role does not establish that exclusion.
- SSM access is privileged operator access. Apply account-level access review/session audit policy; no SSH key or inbound security-group port is provided.

## Tests and limits

`node --test terraform/runtime/watchdog.test.mjs` tests deletion/absence/failure semantics with injected transports only. Terraform mock plans cover dormant resources, disabled activation, private-host/storage properties and explicit cleanup enrollment. They do not launch EC2, attach/mount a real volume, restore backups, deliver queue messages, fetch secrets or delete Runpod resources.

References: [SSM network requirements](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html), [standalone EBS attachment](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/volume_attachment).
