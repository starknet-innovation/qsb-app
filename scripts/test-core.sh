#!/usr/bin/env bash
# Run the isolated regtest Core harness when Bitcoin Core is installed.
# A missing binary, a puzzle-relaxed spend, and a passing report do not close
# MAINNET-READINESS section 6.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${BITCOIN_BIN:-/bitcoin/bin}"
REPORT="${QSB_CORE_REPORT:-}"
if [[ -z "${REPORT}" ]]; then
  REPORT="$(mktemp "${TMPDIR:-/tmp}/qsb-core-regtest.XXXXXX")"
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

# Executable names are not a reviewed Core identity. The enrollment file is
# trusted only when its raw bytes match HEAD:release/source-manifest.json.
# The working-tree manifest is not that record.
set +e
python3 - "${ROOT}/server/runtime/core-binary.json" "${BIN}/bitcoind" "${BIN}/bitcoin-cli" "${ROOT}" <<'PY'
import hashlib, json, subprocess, sys
enrollment_path, _bitcoind, _cli, root = sys.argv[1:5]
try:
    committed = subprocess.check_output(
        ["git", "-C", root, "show", "HEAD:release/source-manifest.json"],
        stderr=subprocess.DEVNULL,
    )
    manifest = json.loads(committed)
    enrollment_bytes = open(enrollment_path, "rb").read()
    expected = manifest["identities"]["sourceFiles"]["server/runtime/core-binary.json"]
    if not isinstance(expected, str) or hashlib.sha256(enrollment_bytes).hexdigest() != expected:
        sys.exit(6)
except Exception:
    sys.exit(6)
identity = json.loads(enrollment_bytes)
if identity.get("format") != "qsb-core-binary-enrollment-v1":
    sys.exit(5)
def sha(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)
both = sha(identity.get("bitcoindSha256")) and sha(identity.get("bitcoinCliSha256"))
neither = identity.get("bitcoindSha256") is None and identity.get("bitcoinCliSha256") is None
if not isinstance(identity.get("enrolled"), bool) or not (both or neither) or identity["enrolled"] != both:
    sys.exit(5)
if identity["enrolled"] is not True:
    sys.exit(3)
def digest(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()
if digest(sys.argv[2]) != identity["bitcoindSha256"] or digest(sys.argv[3]) != identity["bitcoinCliSha256"]:
    sys.exit(4)
PY
status=$?
set -e
if [[ "${status}" -eq 6 ]]; then
  not_run "server/runtime/core-binary.json does not match the committed manifest at HEAD:release/source-manifest.json. An enrollment file that matches only the working-tree manifest is not harness evidence and does not close section 6."
fi
if [[ "${status}" -eq 3 ]]; then
  not_run "No reviewed Bitcoin Core binary is enrolled. An executable named bitcoind is not harness evidence and does not close section 6."
fi
if [[ "${status}" -eq 5 ]]; then
  not_run "server/runtime/core-binary.json is not a valid Core enrollment record. This is not harness evidence and does not close section 6."
fi
if [[ "${status}" -ne 0 ]]; then
  not_run "The Bitcoin Core binaries do not match the enrolled hashes. This is not harness evidence and does not close section 6."
fi

export BITCOIN_BIN="${BIN}"
export QSB_CORE_REPORT="${REPORT}"
python3 "${ROOT}/tests/core_regtest.py"
echo "Core harness wrote ${REPORT}. Section 6 stays open. Puzzle-relaxed spends are not a fresh optimized withdrawal." >&2
