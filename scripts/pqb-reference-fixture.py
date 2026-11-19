"""Regenerate PUBLIC SYNTHETIC fixtures using the pinned independent Python reference.

    python3 scripts/pqb-reference-fixture.py /path/to/fireblocks-labs/pqb v1

The second argument is a construction from src/pqb-core/provenance.json. Check out the commit
it names: v0 writes tests/fixtures/pqb-reference.json, any later one pqb-reference-<version>.json.
No wallet, seed file, network, node or GPU is used. This seed has never held funds.
"""
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]).resolve()
construction = sys.argv[2]
provenance = json.loads((root / "src/pqb-core/provenance.json").read_text())
if construction not in provenance["constructions"]:
    raise SystemExit("Unknown PQB construction")
commit = provenance["constructions"][construction]
if subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() != commit:
    raise SystemExit("Check out the commit of that construction first")
if subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True).strip():
    raise SystemExit("The reference checkout must be clean")
sys.path[:0] = [str(source / "pqb/src/pqb/wasm/shim"), str(source / "pqb/src")]
from pqb import Lock
from pqb import grind, gpu
from test_framework.messages import CTransaction, CTxIn, CTxOut, COutPoint

seed = bytes(range(32))
# v0's commit predates construction versions; later commits build the version asked for.
lock = Lock.new("PQB", seed) if construction == "v0" else Lock.new("PQB", seed, version=construction)
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
out = {"source": provenance["repository"], "commit": commit, "construction": construction,
       "note": "PUBLIC SYNTHETIC fixture; never funded. Problems and trials, not solved stages.",
       "seed": seed.hex(), "scriptHex": lock.scriptpubkey_hex, "manifest": manifest,
       "pinNonce": str(pin), "priorSelection": prior, "stages": stages}
dest = root / "tests/fixtures" / ("pqb-reference.json" if construction == "v0" else f"pqb-reference-{construction}.json")
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(out, indent=2) + "\n")
print("Wrote public PQB reference fixture")
