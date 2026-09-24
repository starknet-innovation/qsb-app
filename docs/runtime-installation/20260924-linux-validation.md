# Native Linux runtime installation validation — 24 September 2026

The isolated Ubuntu 24.04 x86_64 EC2 installation passed. Deployment source was clean, committed and pushed at `d8b820fe96245a954ff83074ab194a6fb4988596` before creating the validation host. The source commit, archive hashes and installed manifests are recorded in [the public native receipt](20260924-native-result.json). This host is a separate CloudFormation validation target in eu-west-1; it does not establish the private Terraform production network or authorize dispatch.

## Verified on the actual host

- Eight installation/credential checks passed: pinned manifests and protected modes; refusal to replace existing installations; rejection of tampering, unlisted files and symlinks; anonymous FIFO delivery with environment isolation; rejection of insecure credential modes and credential symlinks.
- Actual systemd encrypted-credential delivery passed using a **public dummy marker**. The test encrypted artifact and plaintext marker were removed. No real provider credential was read or provisioned.
- Seven watchdog tests passed with real Unix sockets, nonce challenges and deadlines. Provider inspection/deletion was mocked. Failure and identity changes did not become successful cleanup receipts; expiry ran independently of dispatch, including expired enrollment after restart.
- The unchanged sealed runtime and dispatcher were installed read-only. Their manifests were reverified after installation. The two existing pinned amd64 CPU images were preloaded without rebuilding.
- Both service unit files passed `systemd-analyze verify`. The dispatcher unit was loaded and inactive. The protected host configuration retained `executionEnabled:false`.
- The clean application build/typecheck and seven Terraform mock plan tests passed locally. The mock tests are not live AWS resource certification.

The public runtime manifest is `0efcca43ef7bd2599e2432c80724f1a1454e14a8c3ff2cd1ae2d4d66e346114d`; dispatcher manifest is `7b58cc0d980adc7796990eab9bd18707f309b93c8ecf5f5d0d4e48d48768e7f0`. The deployed dispatcher is from the recorded deployment commit, not subsequent documentation commits.

## Remaining enrollment

The operator elected to provision the real encrypted Runpod credential. Follow [the private provisioning procedure](../../supervised/install/OPERATOR-CREDENTIAL.md); return only a success confirmation, never the key or encrypted file. A real disposable endpoint watchdog enrollment and live cleanup test remain pending. No Runpod API calls, GPU allocations, queue submissions, blockchain searches, fixture spends or broadcasts occurred in this validation.

Credential provisioning alone does not complete production integration: protected queue/table/registry configuration and authority enrollment remain required. The sealed historical runtime's isolated table-prefix and registry bindings must be reconciled with the public Terraform configuration before enabling dispatch. Neither installation checks nor a dummy credential test proves an end-to-end provider-backed withdrawal or mainnet readiness.

The validation host is stopped after evidence collection to avoid idle compute. Its encrypted root disk and private artifact bucket are retained for the operator handoff; storage costs continue. Mainnet and automatic dispatch remain disabled.
