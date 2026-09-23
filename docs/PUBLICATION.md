# Public snapshot scope

Prepared for `starknet-innovation/qsb-app` from a separate local export. The working application and historical evidence were left intact.

Included: application and server TypeScript, application tests, historical worker/CPU source, pinned dependency preparation scripts, and the isolated later optimized subset CUDA source.

Excluded: deployment outputs and account configuration, infrastructure stacks specific to the operator, endpoint identifiers, resource control/recovery scripts, all runtime work directories, databases, signed transactions, operational public/private wallet fixtures (synthetic unit-test data remains included), encrypted backups, keys, environment files, binaries, vendored dependency trees, and raw logs.

Publication-only changes:

1. Replaced the historical ECR account in the release descriptor with `000000000000`. Its image location is intentionally nonfunctional; historical source hashes are retained as reference data, not re-attested as a new release.
2. Removed infrastructure deployment and unavailable Core runner commands from package scripts.
3. Redirected browser screenshot paths into local ignored `test-results/`.
4. Added sharing documentation, licensing boundaries, and a restrictive ignore file.

The optimized source is a separate research tree; the historical worker Dockerfile does not select it. Experimental service/host packages currently assembled from the private work directory are excluded pending a self-contained public packaging pass.

Security checks are static screening and review, not a guarantee that all possible sensitive content can be automatically detected. No upstream setup script or cloud deployment ran during export.

Validation results will be recorded below before the initial commit.

## Export validation

- Fresh `npm ci --ignore-scripts`: passed.
- `npm run vendor`: passed; pinned source preparation only, no upstream setup scripts executed.
- `npm test -- --reporter=dot`: **20 files, 134 tests passed** after source preparation. The initial run correctly failed when the ignored vendor sources were absent; setup instructions now include this prerequisite.
- `npm run build`: passed TypeScript and Vite build. Vite reports the existing large JavaScript chunk warning.
- Selected-source screening: no private-key headers, AWS access-key patterns, GitHub-token patterns, credential-bearing HTTP URLs, known operator account/endpoint/secret identifiers, or local home paths found. This is not a comprehensive security audit.
- Browser/GPU tests, deployment, external mining, and a fresh withdrawal were not run for this export.
