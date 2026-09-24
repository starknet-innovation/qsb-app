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

not_run() {
  QSB_CORE_CLASSIFY_ONLY=1 \
  QSB_CORE_NOT_RUN_REASON="$1" \
    python3 "${ROOT}/tests/core_regtest.py" > "${REPORT}"
  echo "Core harness not run: $1" >&2
  echo "not-run report: ${REPORT}" >&2
  exit 2
}

if [[ ! -x "${BIN}/bitcoind" || ! -x "${BIN}/bitcoin-cli" ]]; then
  not_run "Bitcoin Core binaries are not available at ${BIN}. This is not a Core validation and does not close section 6."
fi

# Executable names are not a reviewed Core identity. This checkout enrolls no binary hash.
set +e
python3 - "${ROOT}/server/runtime/core-binary.json" "${BIN}/bitcoind" "${BIN}/bitcoin-cli" <<'PY'
import hashlib, json, sys
identity = json.load(open(sys.argv[1]))
if identity.get("enrolled") is not True or not identity.get("bitcoindSha256") or not identity.get("bitcoinCliSha256"):
    sys.exit(3)
def digest(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()
if digest(sys.argv[2]) != identity["bitcoindSha256"] or digest(sys.argv[3]) != identity["bitcoinCliSha256"]:
    sys.exit(4)
PY
status=$?
set -e
if [[ "${status}" -eq 3 ]]; then
  not_run "No reviewed Bitcoin Core binary is enrolled. An executable named bitcoind is not harness evidence and does not close section 6."
fi
if [[ "${status}" -ne 0 ]]; then
  not_run "The Bitcoin Core binaries do not match the enrolled hashes. This is not harness evidence and does not close section 6."
fi

export BITCOIN_BIN="${BIN}"
export QSB_CORE_REPORT="${REPORT}"
python3 "${ROOT}/tests/core_regtest.py"
echo "Core harness wrote ${REPORT}. Section 6 stays open. Puzzle-relaxed spends are not a fresh optimized withdrawal." >&2
