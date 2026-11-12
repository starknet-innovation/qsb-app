"""Regenerate PUBLIC SYNTHETIC fixtures using the pinned independent Python reference.

    python3 scripts/pqb-reference-fixture.py /path/to/fireblocks-labs/pqb

No wallet, seed file, network, node or GPU is used. This seed has never held funds.
"""
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]).resolve()
provenance = json.loads((root / "src/pqb-core/provenance.json").read_text())
if subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() != provenance["commit"]:
    raise SystemExit("Check out the pinned PQB commit first")
if subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True).strip():
    raise SystemExit("The reference checkout must be clean")
sys.path[:0] = [str(source / "pqb/src/pqb/wasm/shim"), str(source / "pqb/src")]
from pqb import Lock
from pqb import grind, gpu
from test_framework.messages import CTransaction, CTxIn, CTxOut, COutPoint

seed = bytes(range(32))
lock = Lock.new("PQB", seed)
manifest = {
    "vaultId": "00000000-0000-4000-8000-000000000001",
    "idempotencyKey": "00000000-0000-4000-8000-000000000002",
    "funding": {"txid": "11" * 32, "vout": 0, "value": "100000"},
    "helper": {"txid": "22" * 32, "vout": 1, "value": "10000"},
    "outputScript": "0014" + "33" * 20,
    "destination": "bc1qxvenxvenxvenxvenxvenxvenxvenxven2ymjt8",
    "outputValue": "109000", "fee": "1000", "costAccepted": True,
}
tx = CTransaction()
tx.version = 1
tx.nLockTime = 500000000
tx.vin = [CTxIn(COutPoint(int(manifest["helper"]["txid"], 16), 1), b"", 0xfffffffe),
          CTxIn(COutPoint(int(manifest["funding"]["txid"], 16), 0), b"", 0x80000000)]
tx.vout = [CTxOut(109000, bytes.fromhex(manifest["outputScript"]))]
pin = 12345678901
prior = [3, 9, 17, 22, 40, 55, 61, 70]
packets = grind.packets_for_lock(lock, tx.serialize().hex(), n_in=1, pin_nonce=pin,
                               prior_selections=[prior])
stages = []
for p in packets:
    trials = []
    for nonce, variant, menu, encoding in [(0, 0, 0, 0), (12345, 1, 7, 0), (54321, 0, 11, 0)]:
        digest, z = grind.evaluate(p, nonce, variant, menu, encoding, 0, with_z=True)
        trials.append({"nonce": str(nonce), "variant": variant, "menuIndex": menu,
                       "encoding": encoding, "digest": digest.hex(), "z": str(z)})
    stages.append({"problem": gpu.problem_txt(gpu.problem_from_packet(p)), "trials": trials})
out = {"source": provenance["repository"], "commit": provenance["commit"],
       "note": "PUBLIC SYNTHETIC fixture; never funded. Problems and trials, not solved stages.",
       "seed": seed.hex(), "scriptHex": lock.scriptpubkey_hex, "manifest": manifest,
       "pinNonce": str(pin), "priorSelection": prior, "stages": stages}
dest = root / "tests/fixtures/pqb-reference.json"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(out, indent=2) + "\n")
print("Wrote public PQB reference fixture")
