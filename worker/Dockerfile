FROM nvidia/cuda:12.8.1-devel-ubuntu22.04 AS build
RUN apt-get update && apt-get install -y --no-install-recommends libssl-dev python3 && rm -rf /var/lib/apt/lists/*
ARG CUDA_ARCH=89
WORKDIR /build
COPY vendor/challenge/candidates /src/vendor/challenge/candidates
COPY worker/prepare_kernels.py /src/worker/prepare_kernels.py
RUN python3 /src/worker/prepare_kernels.py
RUN nvcc -O3 -arch=sm_${CUDA_ARCH} -DQSB_SLOTPIPE=0 -o /pinning /src/worker/build/pinning/pinning.cu -lcrypto -lm
RUN nvcc -O3 -arch=sm_${CUDA_ARCH} -DZLAB_TRIM=0 -DZLAB_K2S=0 -o /subset /src/worker/build/subset/subset.cu -lcrypto -lm
FROM nvidia/cuda:12.8.1-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip libssl3 && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --no-cache-dir runpod==1.7.13
WORKDIR /opt/qsb
COPY --from=build /pinning /subset ./
COPY --from=build /src/worker/build /opt/qsb/source
COPY worker/handler.py worker/search_ranges.py ./
ENV PYTHONUNBUFFERED=1
CMD ["python3", "handler.py"]
