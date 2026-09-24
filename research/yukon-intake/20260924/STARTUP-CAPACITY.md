# Serverless startup capacity assessment

Status: unresolved for the strict one-test-GPU limit. Read-only assessment on 24 September 2026; no allocation, enrollment change or provider mutation.

## Observed evidence

The saved remote queue receipt records one running and two initializing worker records while the isolated endpoint was configured with `workersMax=1`. The endpoint was paused and deleted after the already submitted job completed. The second planned job was not submitted. These records do not establish three simultaneously allocated or billed GPUs.

## Provider documentation

Runpod documents extra startup workers (default two) and marks initializing workers as unbilled. This is consistent with the observation, but does not establish the physical GPU allocation of each initializing record. See [worker overview](https://docs.runpod.io/serverless/workers/overview).

Runpod describes maximum workers as the concurrent-instance cap and maximum zero as pausing the endpoint. That setting alone did not bound the observed initialization records. See [endpoint settings](https://docs.runpod.io/serverless/endpoints/endpoint-configurations).

The official CLI at immutable commit `4351fca9ec454b1bdc8572aaad5d3e5a61ead0fa` queries a `workersStandby` field, but its create input does not expose that field. The newer REST endpoint update type also does not expose a standby control. This inspection does not prove that no such control exists anywhere; it establishes that no supported disable control was identified in these inspected interfaces:

- [GraphQL endpoint input and query](https://github.com/runpod/runpodctl/blob/4351fca9ec454b1bdc8572aaad5d3e5a61ead0fa/api/endpoint.go)
- [REST endpoint types](https://github.com/runpod/runpodctl/blob/4351fca9ec454b1bdc8572aaad5d3e5a61ead0fa/internal/api/endpoints.go)

The unauthenticated public OpenAPI request returned HTTP 403. No undocumented parameter was tried and no credentials were retrieved for schema exploration.

## Consequence for dispatch

Keep `startupCapacityValidated` false/absent for live serverless enrollment. Documentation, an empty queue, and `workersMax=1` are insufficient evidence to set it true. Local tests that explicitly set this field use mocked provider transport; they do not certify live capacity.

Closing this gate requires supported provider semantics that bound physical allocation, or an explicitly approved revised capacity constraint. A separately managed one-GPU pod can support further solver testing under the existing pod rules, but it cannot certify serverless startup behavior. No provider support request has been sent.

Local correctness, positive-result publication preparation and review can continue without enabling paid dispatch. All spent fixtures and proof endpoints remain excluded.
