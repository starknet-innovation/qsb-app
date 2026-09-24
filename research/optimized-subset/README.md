# Optimized subset source — isolated research

This directory preserves the 32 source files from the later OpenSSL-error-checked candidate snapshot, derived from the repaired 1650caf subset candidate. Changes include generic tail SHA schedule caching, bounded exact exceptional-point recovery, checked CUDA host operations and output publication, and checked OpenSSL calls. Original upstream sources and earlier research remain outside this export.

This is not the original leaderboard submission and is not deployed by the application. The historical `worker/Dockerfile` builds a different pinned baseline. No binary is shipped here; building these files does not establish the identity or correctness of an earlier measured binary.

For review: the generic ranked path, exact recovery helpers, and `subset/tests/gpu_epochs/tree.cu` are the relevant implementation. Specialized paths and arbitrary compiler flag combinations are not certified. More than 64 retained hit records fails closed rather than supporting unbounded output. A deterministic failure must not be credited as completed coverage or blindly retried.

Component performance evidence and remaining integrated release gates are summarized in `../../docs/STATUS.md`. The [public optimized worker build](../../worker/optimized/README.md) now compiles these files with pinned CUDA/base-image identities and recorded flags. Fresh output identities still need enrollment, GPU validation and optimized withdrawal evidence.

See LICENSE for the upstream Apache-2.0 terms. The files include local modifications; no upstream endorsement is implied.
