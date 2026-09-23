#!/usr/bin/env bash
# Run the isolated regtest Core harness when Bitcoin Core is installed.
# A missing binary, a puzzle-relaxed spend, and a passing report do not close
# MAINNET-READINESS section 6.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${BITCOIN_BIN:-/bitcoin/bin}"
REPORT="${QSB_CORE_REPORT:-}"
if [[ -z "${REPORT}" ]]; then
  REPORT="$(mktemp "${TMPDIR:-/tmp}/qsb-core-regtest.XXXXXX.json")"
fi
mkdir -p "$(dirname "${REPORT}")"

if [[ ! -x "${BIN}/bitcoind" || ! -x "${BIN}/bitcoin-cli" ]]; then
  QSB_CORE_CLASSIFY_ONLY=1 \
  QSB_CORE_NOT_RUN_REASON="Bitcoin Core binaries are not available at ${BIN}. This is not a Core validation and does not close section 6." \
    python3 "${ROOT}/tests/core_regtest.py" > "${REPORT}"
  echo "Core harness not run: bitcoind is not available at ${BIN}" >&2
  echo "not-run report: ${REPORT}" >&2
  exit 2
fi

export BITCOIN_BIN="${BIN}"
export QSB_CORE_REPORT="${REPORT}"
python3 "${ROOT}/tests/core_regtest.py"
echo "Core harness wrote ${REPORT}. Section 6 stays open. Puzzle-relaxed spends are not a fresh optimized withdrawal." >&2
