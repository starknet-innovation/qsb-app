FROM nvidia/cuda:12.8.1-devel-ubuntu22.04@sha256:6617a625f4090c76c545a0e7d63f2e441718ef9af7f4efe7dd1242a29e289fd7 AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY research/optimized-subset /src/research/optimized-subset
COPY worker/optimized /src/worker/optimized
ENV PYTHONDONTWRITEBYTECODE=1
RUN python3 /src/worker/optimized/build.py
FROM nvidia/cuda:12.8.1-runtime-ubuntu22.04@sha256:fcbbd60a5ad3db3a1c7375bf14546b369b54064c513224310b2026df50c7a9bd AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/qsb-validation /opt/qsb-validation
WORKDIR /opt/qsb-validation
ENV PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["python3", "/opt/qsb-validation/runtime.py"]
FROM runtime AS queue
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir runpod==1.7.13
ENTRYPOINT ["/opt/venv/bin/python", "-u", "/opt/qsb-validation/queue_handler.py"]
