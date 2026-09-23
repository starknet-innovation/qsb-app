"""Compare instrumented GPU output to emulator and full transaction sighashes."""
from pathlib import Path
import json,re,sys
from collections import defaultdict
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'worker/cpu'))
from gpu_emulator import emulate_pinning,emulate_digest_round
from bitcoin_tx import Transaction,TxIn,TxOut,find_and_delete

def check(log,case,stage,sequence=0x80000000,locktime=500000000):
    case=Path(case);state=json.loads((case/'qsb_state.json').read_text())
    params=json.loads((case/('gpu_pinning_params.json' if stage=='pinning' else f'gpu_digest_r{stage}_params.json')).read_text())
    observations=defaultdict(dict)
    for line in Path(log).read_text().splitlines():
        if stage=='pinning':
            m=re.fullmatch(r'TRACE_PIN seq=(\d+) lt=(\d+) recid=(\d) hash=([a-f0-9]{64})',line)
            if m: observations[(int(m[1]),int(m[2]))][int(m[3])]=m[4]
        else:
            m=re.fullmatch(r'TRACE_SUB indices=([0-9,]+) recid=(\d) hash=([a-f0-9]{64})',line)
            if m: observations[tuple(sorted(149-int(i) for i in m[1].split(',')))][int(m[2])]=m[3]
    if not observations: raise AssertionError('No GPU trace records')
    for key,hashes in observations.items():
        if set(hashes)!={0,1}: raise AssertionError(f'Missing GPU recovery branch: {key}')
        seq,lt=key if stage=='pinning' else (sequence,locktime)
        if stage=='pinning':
            expected=emulate_pinning(params,lt,sequence=seq)
            sc=find_and_delete(bytes.fromhex(state['full_script_hex']),bytes.fromhex(state['pin_sig']))
        else:
            expected=emulate_digest_round(params,list(key),sequence=seq,locktime=lt)
            sc=find_and_delete(bytes.fromhex(state['full_script_hex']),bytes.fromhex(state['round_sigs'][stage-1]['sig']))
            for index in key: sc=find_and_delete(sc,bytes.fromhex(state['dummy_sigs'][stage-1][index]))
        sp=params['spending_tx'];tx=Transaction(version=sp['version'],locktime=lt)
        tx.add_input(TxIn(bytes.fromhex(sp['extra_input']['txid'])[::-1],sp['extra_input']['vout'],b'',sp['extra_input']['sequence']))
        tx.add_input(TxIn(bytes.fromhex(sp['qsb_input']['txid'])[::-1],sp['qsb_input']['vout'],b'',seq))
        tx.add_output(TxOut(sp['output']['value'],bytes.fromhex(sp['output']['script_pubkey'])))
        if tx.sighash(1,sc,0x01).to_bytes(32,'big')!=expected['sighash']: raise AssertionError('Emulator/full-transaction sighash mismatch')
        cpu={c['puzzle_hash'].hex() for c in expected['candidates']}
        if set(hashes.values())!=cpu: raise AssertionError(f'CPU/GPU hash mismatch at {key}: GPU {hashes} CPU {cpu}')
    return {'stage':stage,'cases':len(observations),'recoveredKeyHashes':len(observations)*2,'matched':True}

if __name__=='__main__':
    print(json.dumps(check(sys.argv[1],sys.argv[2],sys.argv[3] if sys.argv[3]=='pinning' else int(sys.argv[3]),int(sys.argv[4],0) if len(sys.argv)>4 else 0x80000000,int(sys.argv[5]) if len(sys.argv)>5 else 500000000)))
