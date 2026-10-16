#!/usr/bin/env python3
"""Focused round-1 replay regression adapted from upstream PR7 test_consensus_cpu.py.

MIT upstream source: avihu28/Quantum-Safe-Bitcoin-Transactions,
b22f81c093488d09b9cd59c171c79b6c40812cf1 (license public/qsb/LICENSE).
Uses the app Config A builder and real ECDSA/HORS checks. ONLY the three
hash-to-DER puzzle checks are relaxed at their explicit CHECKSIGVERIFY sites.
This bounded Python interpreter is not Core or fresh full-search certification.
All keys/outpoints are synthetic and ephemeral; no funding, network or fixtures.
"""
import sys, hashlib
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'public/qsb'))
import bitcoin_tx as bt
from bitcoin_tx import QSBScriptBuilder, Transaction, TxIn, TxOut, find_and_delete, push_data, push_number
from secp256k1 import N, P, ecdsa_recover, ecdsa_verify, decompress_pubkey, compress_pubkey, encode_der_sig, hash160 as h160, ripemd160
legacy = '--legacy' in sys.argv
if legacy:
    class LegacyBuilder(QSBScriptBuilder):
        # Reproduce the previous two plain-CMS script and shared stack depths.
        def _emit_round(self, m, round_idx, sig_nonce_bytes, subset, terminal):
            return super()._emit_round(m, round_idx, sig_nonce_bytes, subset, terminal=True)
    QSBScriptBuilder = LegacyBuilder

def parse_der(sig):
    """Return (r,s,flag) if `sig` is valid DER (+trailing flag byte), else None."""
    if len(sig) < 9 or sig[0] != 0x30: return None
    tl = sig[1]
    if tl + 3 != len(sig): return None
    idx = 2
    if sig[idx] != 0x02: return None
    idx += 1; rl = sig[idx]; idx += 1
    if rl == 0 or idx+rl > len(sig)-1: return None
    if rl > 1 and sig[idx] == 0 and not (sig[idx+1] & 0x80): return None
    if sig[idx] & 0x80: return None
    r = int.from_bytes(sig[idx:idx+rl], 'big'); idx += rl
    if sig[idx] != 0x02: return None
    idx += 1; sl = sig[idx]; idx += 1
    if sl == 0 or idx+sl != len(sig)-1: return None
    s = int.from_bytes(sig[idx:idx+sl], 'big')
    return (r, s, sig[-1])

def recover_key(r, s, z):
    """Recover a pubkey that verifies (r,s) over z (try both recids / r,r+N)."""
    for rr in ([r] + ([r+N] if r+N < P else [])):
        for recid in (0, 1):
            pt = ecdsa_recover(rr, s, z, recid)
            if pt and ecdsa_verify(pt, z, r, s):
                return compress_pubkey(pt)
    return None

# ══════════════════════════════════════════════════════════════════
# 1. Build the corrected lock (Config A) with real keys
# ══════════════════════════════════════════════════════════════════
b = QSBScriptBuilder(150, 8, 1, 7, 2, hash_mode='sha256')
b.generate_keys()
# distinct SIGHASH_ALL anchors; r MUST be a valid on-curve x-coordinate so
# key recovery works. Same r, distinct s → 3 distinct minimal 9-byte sigs;
# flag 0x01 keeps them distinct from the dummies (flag 0x03).
from bitcoin_tx import _valid_small_r_values
vr = _valid_small_r_values()[0]
pin_sig      = encode_der_sig(vr, 1, 0x01)
sig_nonce    = [encode_der_sig(vr, 2, 0x01), encode_der_sig(vr, 3, 0x01)]
lock = b.build_full_script(pin_sig, sig_nonce[0], sig_nonce[1])
print(f"lock: {len(lock)} bytes")

# ══════════════════════════════════════════════════════════════════
# 2. Spending tx (2 inputs, 1 output).  QSB at input 1.  Arbitrary
#    locktime/sequence/subsets — no search needed (puzzle relaxed).
# ══════════════════════════════════════════════════════════════════
QSB = 1
tx = Transaction(version=1, locktime=1234567)
tx.add_input(TxIn(b'\x00'*32, 0, b'', 0xfffffffe))            # helper (input 0)
tx.add_input(TxIn(b'\x11'*32, 0, b'', 0x80000000))            # QSB    (input 1)
tx.add_output(TxOut(90000, bytes([0x00,0x14])+b'\x22'*20))     # 1 output (SIGHASH_SINGLE bug at input 1)
subs = {0: sorted([3,17,42,66,88,101,119,140])+[9],
        1: sorted([5,20,55,70,90,110,130])+[15,45]}
idxvals = b.compute_witness_indices(subs)

# ══════════════════════════════════════════════════════════════════
# 3. Assemble the witness with REAL recovered keys / preimages
# ══════════════════════════════════════════════════════════════════
def recover_round_keys(R, tx=tx):
    sc = find_and_delete(lock, sig_nonce[R])
    for i in subs[R]:
        sc = find_and_delete(sc, b.dummy_sigs[R][i])
    z = tx.sighash(QSB, sc, 0x01)
    pr, ps, _ = parse_der(sig_nonce[R])
    key_nonce = recover_key(pr, ps, z)
    dummy_pub = []
    for i in subs[R]:
        dr, ds, _ = parse_der(b.dummy_sigs[R][i])
        dummy_pub.append(recover_key(dr, ds, 1 << 248))  # z=2**248 (corrected SIGHASH_SINGLE bug)
    return key_nonce, dummy_pub

def round_witness(R, tx=tx):
    ts = b.t1_signed if R == 0 else b.t2_signed
    key_nonce, dummy_pub = recover_round_keys(R, tx)
    assert key_nonce and all(dummy_pub), f"recovery failed round {R}"
    w  = push_data(b'\x02'+b'\x00'*32)                # key_puzzle (relaxed → unused)
    w += push_data(key_nonce)                          # key_nonce (REAL)
    for pub in reversed(dummy_pub): w += push_data(pub)
    for j in range(ts-1, -1, -1): w += push_data(b.hors_secrets[R][subs[R][j]])
    for j in range(len(idxvals[R])-1, -1, -1): w += push_number(idxvals[R][j])
    return w

witness = round_witness(1) + round_witness(0)
# pinning
pin_sc = find_and_delete(lock, pin_sig)
z_pin = tx.sighash(QSB, pin_sc, 0x01)
ppr, pps, _ = parse_der(pin_sig)
key_nonce_pin = recover_key(ppr, pps, z_pin)
assert key_nonce_pin, "pinning recovery failed"
pin_witness = push_data(b'\x02'+b'\x00'*32) + push_data(key_nonce_pin)   # key_puzzle_pin relaxed
witness += pin_witness

# ATTACK witness: round 1's block is replayed from a DIFFERENT transaction (same
# inputs, another payee), i.e. what an observer of one honest spend holds. Pinning
# and round 2 are recomputed for `tx`. Round 1's multisig must reject it.
tx_other = Transaction(version=1, locktime=1234567)
tx_other.add_input(TxIn(b'\x00'*32, 0, b'', 0xfffffffe))
tx_other.add_input(TxIn(b'\x11'*32, 0, b'', 0x80000000))
tx_other.add_output(TxOut(90000, bytes([0x00,0x14])+b'\x99'*20))
witness_replay = round_witness(1) + round_witness(0, tx_other) + pin_witness
witness_replay2 = round_witness(1, tx_other) + round_witness(0) + pin_witness
preimage = b.hors_secrets[0][subs[0][0]]
changed = bytes([preimage[0] ^ 1]) + preimage[1:]
assert witness.count(push_data(preimage)) == 1
witness_wrong_hors = witness.replace(push_data(preimage), push_data(changed), 1)

# ══════════════════════════════════════════════════════════════════
# 4. Interpret with REAL ECDSA (relax only the unsolved puzzle)
# ══════════════════════════════════════════════════════════════════
def toks(sc):
    i=0
    while i<len(sc):
        op=sc[i]
        if op==0: yield('p',b''); i+=1
        elif 1<=op<=75: yield('p',sc[i+1:i+1+op]); i+=1+op
        elif op==0x4c: k=sc[i+1]; yield('p',sc[i+2:i+2+k]); i+=2+k
        elif op==0x4d: k=sc[i+1]|sc[i+2]<<8; yield('p',sc[i+3:i+3+k]); i+=3+k
        elif 0x51<=op<=0x60: yield('p',bytes([op-0x50])); i+=1
        else: yield('o',op); i+=1
def di(x):
    if not x: return 0
    v=int.from_bytes(x,'little')
    if x[-1]&0x80: v&=(1<<(8*len(x)))-1-(0x80<<(8*(len(x)-1))); v=-v
    return v
def ei(v):
    if v==0: return b''
    o=bytearray(); y=abs(v)
    while y: o.append(y&0xff); y>>=8
    if o[-1]&0x80: o.append(0)
    return bytes(o)

def checksig_real(sig, pubkey, all_check_sigs, allow_puzzle=False):
    """REAL ecdsa verify over the legacy sighash. Relax if sig isn't valid DER
    (an unsolved puzzle sig) — that's the only relaxation."""
    p = parse_der(sig)
    if p is None:
        return ('relaxed', True) if allow_puzzle and len(sig) == 32 else ('real', False)
    r, s, flag = p
    sc = lock
    for cs in all_check_sigs: sc = find_and_delete(sc, cs)
    z = tx.sighash(QSB, sc, flag)          # z=1 automatically for SIGHASH_SINGLE @ input1
    try: pt = decompress_pubkey(pubkey)
    except Exception: return ('real', False)
    return ('real', ecdsa_verify(pt, z, r, s))

# round 1 must end in CHECKMULTISIGVERIFY: only the top stack item is checked at
# script end, so a plain CHECKMULTISIG there is buried under round 2 and never enforced
assert [v for k,v in toks(lock) if k=='o' and v in (0xae,0xaf)] == ([0xae,0xae] if legacy else [0xaf,0xae])

def run(witness):
    global hors, cms, real_sig, relaxed
    st = [v for k,v in toks(witness)]
    hors=0; cms=0; real_sig=0; relaxed=0; fail=None; checksig_count=0
    for k,v in toks(lock):
        if k=='p': st.append(v); continue
        op=v
        try:
            if op==0x7a: nn=di(st.pop()); st.append(st.pop(-1-nn))
            elif op==0x76: st.append(st[-1])
            elif op==0x78: st.append(st[-2])
            elif op==0x7c: st[-1],st[-2]=st[-2],st[-1]
            elif op==0x93: y=di(st.pop());x=di(st.pop());st.append(ei(x+y))
            elif op==0xa3: y=di(st.pop());x=di(st.pop());st.append(ei(min(x,y)))
            elif op==0xa9: st.append(h160(st.pop()))
            elif op==0xa8: st.append(hashlib.sha256(st.pop()).digest())
            elif op==0xa6: st.append(ripemd160(st.pop()))
            elif op==0x88:                                   # OP_EQUALVERIFY = HORS
                a=st.pop(); c=st.pop()
                if a==c: hors+=1
                elif fail is None: fail=('HORS',a.hex()[:12],c.hex()[:12])
            elif op==0xad:                                   # OP_CHECKSIGVERIFY
                pub=st.pop(); sig=st.pop()
                checksig_count += 1
                kind,ok=checksig_real(sig, pub, [sig], allow_puzzle=checksig_count in (2,3,4))
                if kind=='real': real_sig+=1
                else: relaxed+=1
                if not ok and fail is None: fail=('CHECKSIG',sig.hex()[:16],pub.hex()[:12])
            elif op in (0xae,0xaf):                          # OP_CHECKMULTISIG[VERIFY] (REAL, ordered)
                nk=di(st.pop()); pubs=[st.pop() for _ in range(nk)][::-1]
                ns=di(st.pop()); sigs=[st.pop() for _ in range(ns)][::-1]
                st.pop()                                      # the OP_0 dummy
                allcs=[s for s in sigs if parse_der(s)]       # F&D all real sigs in this CMS
                si=0; matched=0
                for sig in sigs:
                    while si<nk:
                        kind,ok=checksig_real(sig, pubs[si], allcs)
                        if ok: matched+=1; si+=1; break
                        si+=1
                    else: break
                    if kind=='real': real_sig+=1
                    else: relaxed+=1
                good = (matched==ns)
                st.append(b'\x01' if good else b''); cms+=1
                # consensus: a false plain CHECKMULTISIG is only a pushed value; VERIFY aborts
                if op==0xaf:
                    st.pop()
                    if not good: fail=('CMSVERIFY', f'{matched}/{ns}', ''); break
            else:
                raise ValueError(f'Unsupported opcode {op:x}')
        except Exception as e:
            fail=('crash',str(e),''); break

    top = st[-1] if st else b''
    truthy = any(x!=0 for x in top)
    return truthy, fail

truthy, fail = run(witness)
exp_hors = b.t1_signed + b.t2_signed
print(f"HORS: {hors}/{exp_hors}   CHECKMULTISIGs: {cms}/2   real ECDSA checks: {real_sig}   relaxed(puzzle): {relaxed}")
print(f"final stack TRUE: {truthy}")
if fail: print("FAIL:", fail)
ok = (hors==exp_hors and cms==2 and relaxed==3 and truthy and fail is None)

# negative: the replayed round-1 block must be rejected by round 1's CHECKMULTISIGVERIFY
r_truthy, r_fail = run(witness_replay)
rejected = (r_fail is not None and r_fail[0]=='CMSVERIFY')
if legacy:
    ok = ok and r_truthy and r_fail is None
    print(f"legacy replay accepted: {r_truthy and r_fail is None}")
else:
    ok = ok and rejected
    print(f"corrected replay rejected: {rejected}")
r2_truthy, r2_fail = run(witness_replay2)
ok = ok and (not r2_truthy or r2_fail is not None)
h_truthy, h_fail = run(witness_wrong_hors)
ok = ok and h_fail is not None and h_fail[0] == 'HORS'
print("round-2 replay and wrong HORS rejected:", not r2_truthy and h_fail is not None)
print("RELAXED-PUZZLE COMPONENT REGRESSION: " + ("PASS" if ok else "FAIL"))
sys.exit(0 if ok else 1)
