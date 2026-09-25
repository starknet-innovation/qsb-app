#!/bin/bash
set -euo pipefail
# Arguments are verified public identities and the current price, never secrets.
artifact_dir=$1
expected_image=$2
controller_commit=$3
hourly_usd=$4
[ -f /run/qsb-shutdown-armed ]
systemctl is-active --quiet qsb-benchmark-expire.timer
mkdir /var/lib/qsb-benchmark-started
mkdir /results
cd "$artifact_dir"
sha256sum -c SHA256SUMS
gzip -dc image.tar.gz | docker load
[ "$(docker image inspect qsb-aws-benchmark:sm86 --format '{{.Id}}')" = "$expected_image" ]
printf '%s\n' "$controller_commit" > /results/controller-commit.txt
nvidia-smi > /results/nvidia-smi.txt
set +e
timeout --signal=TERM --kill-after=10s 30m docker run --rm --gpus all \
    --network none --read-only --cap-drop ALL --tmpfs /tmp:rw,nosuid,nodev \
    --mount type=bind,src=/results,dst=/results qsb-aws-benchmark:sm86 \
    --hourly-usd "$hourly_usd" > /results/benchmark.log 2>&1
result=$?
set -e
printf '%s\n' "$result" > /results/exit-code.txt
chmod -R a+rX /results
exit "$result"
