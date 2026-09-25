FROM nvidia/cuda:12.8.1-devel-ubuntu22.04@sha256:6617a625f4090c76c545a0e7d63f2e441718ef9af7f4efe7dd1242a29e289fd7 AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 libssl-dev && rm -rf /var/lib/apt/lists/*
COPY research/optimized-subset /src/research/optimized-subset
COPY worker/optimized/source-lock.json /src/worker/optimized/source-lock.json
COPY ops/aws-gpu-benchmark /src/ops/aws-gpu-benchmark
ARG CUDA_ARCH=86
RUN python3 /src/ops/aws-gpu-benchmark/build.py ${CUDA_ARCH}
FROM nvidia/cuda:12.8.1-runtime-ubuntu22.04@sha256:fcbbd60a5ad3db3a1c7375bf14546b369b54064c513224310b2026df50c7a9bd
RUN apt-get update && apt-get install -y --no-install-recommends python3 libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/qsb-benchmark /opt/qsb-benchmark
COPY worker/cpu /src/worker/cpu
COPY ops/aws-gpu-benchmark /src/ops/aws-gpu-benchmark
ENV OPENSSL_CONF=/src/ops/aws-gpu-benchmark/openssl.cnf
RUN python3 -m unittest discover -s /src/ops/aws-gpu-benchmark -p 'test_*.py'
RUN python3 /src/ops/aws-gpu-benchmark/prepare.py /opt/qsb-benchmark/fixture
ENV PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["python3", "/src/ops/aws-gpu-benchmark/run.py"]
