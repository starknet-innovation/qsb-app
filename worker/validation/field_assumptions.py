"""CPU checks for the admitted 256-bit field rule and the strict DER predicate.

These checks do not execute the CUDA schedule, the divstep inverse, or a GPU.
"""
import json
import random
import sys
from pathlib import Path

CPU = Path(__file__).resolve().parents[1] / "cpu"
sys.path.insert(0, str(CPU))
from gpu_emulator import is_valid_der  # noqa: E402
from secp256k1 import G, INF, P, modinv, point_add, point_neg  # noqa: E402

FIELD_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
LIMB = (1 << 64) - 1
P0 = 0xFFFFFFFEFFFFFC2F


def normalize(value):
    if value < 0 or value >= 1 << 256:
        raise ValueError("value is outside the admitted 256-bit representation")
    limbs = [(value >> (64 * i)) & LIMB for i in range(4)]
    if limbs[1] == LIMB and limbs[2] == LIMB and limbs[3] == LIMB and limbs[0] >= P0:
        limbs[0] -= P0
        limbs[1] = limbs[2] = limbs[3] = 0
    out = limbs[0] | (limbs[1] << 64) | (limbs[2] << 128) | (limbs[3] << 192)
    if out != value % FIELD_P or out >= FIELD_P:
        raise SystemExit(f"normalization mismatch for {value:#x}")
    return out


def exact_der(digest, easy=False, relaxed=False):
    """Host qsb_exact_der, strict mode, on a 32-byte buffer."""
    if easy and not relaxed:
        return (digest[0] >> 4) == 3
    if (not relaxed and digest[0] != 0x30) or digest[1] != 29:
        return False
    index = 2
    for _ in range(2):
        if index >= 31 or digest[index] != 2:
            return False
        index += 1
        length = digest[index]
        index += 1
        if (
            not length
            or index + length > 31
            or (digest[index] & 128)
            or (length > 1 and digest[index] == 0 and not (digest[index + 1] & 128))
        ):
            return False
        index += length
    return index == 31


def main():
    if 2 * FIELD_P <= 1 << 256:
        raise SystemExit("a 256-bit word can exceed 2p; one subtraction is not enough")
    rng = random.Random(23)
    samples = [
        0,
        1,
        FIELD_P - 1,
        FIELD_P,
        FIELD_P + 1,
        (1 << 256) - 1,
        (1 << 256) - FIELD_P,
        1 << 255,
    ]
    samples.extend(rng.randrange(1 << 256) for _ in range(200))
    for value in samples:
        normalize(value)

    valid = bytes([0x30, 29, 2, 12]) + bytes([0x11]) * 12 + bytes([2, 13]) + bytes([0x22]) * 13 + bytes([1])
    vectors = [valid]
    for pos in range(32):
        for value in (0, 1, 0x7F, 0x80, 0xFF):
            mutated = bytearray(valid)
            mutated[pos] = value
            vectors.append(bytes(mutated))
    vectors.extend(rng.randbytes(32) for _ in range(64))
    agreements = 0
    for digest in vectors:
        if bool(is_valid_der(digest)) != exact_der(digest):
            raise SystemExit(f"DER predicate mismatch {digest.hex()}")
        agreements += 1
    if exact_der(valid, easy=True, relaxed=False) is not ((valid[0] >> 4) == 3):
        raise SystemExit("easy mode is not the strict predicate")

    if point_add(INF, G) != G or point_add(G, INF) != G:
        raise SystemExit("infinity is not the affine identity")
    if point_add(G, point_neg(G)) != INF:
        raise SystemExit("negation did not produce the exceptional sum")
    try:
        modinv(0, P)
    except ValueError:
        pass
    else:
        raise SystemExit("zero denominator was inverted")

    json.dump(
        {
            "ok": True,
            "normalizationVectors": len(samples),
            "derAgreements": agreements,
            "gpuExecuted": False,
        },
        sys.stdout,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
