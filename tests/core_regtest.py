"""Bitcoin Core block-consensus tests, never a production withdrawal certificate.

Run inside the isolated container via scripts/test-core.sh. No mainnet RPC, keys,
network peers, or real coins. Puzzle-relaxed fixtures are labelled explicitly.
A passing run, including the puzzle-relaxed spend, does not close MAINNET-READINESS
section 6. Known-solution replay, synthetic no-hit ranges, and mocked success are
not a fresh optimized withdrawal.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'vendor/qsb/config_a/pipeline'))
sys.path.insert(0, str(ROOT / 'vendor/qsb/config_a/verify'))
from bitcoin_tx import Transaction, TxIn, TxOut, QSBScriptBuilder, find_and_delete, push_data, push_number, _valid_small_r_values
from secp256k1 import encode_der_sig
from test_consensus_core import relax, parse_der, recover_key

BIN = Path(os.environ.get('BITCOIN_BIN', '/bitcoin/bin'))
REPORT = Path(os.environ.get('QSB_CORE_REPORT', '/results/results.json'))


def section6_annotation():
    return {
        'fullProductionWithdrawalVerified': False,
        'freshOptimizedWithdrawal': False,
        'section6Closed': False,
        'puzzleRelaxedIsNotFreshSearch': True,
        'knownSolutionReplayIsNotFreshSearch': True,
        'syntheticNoHitIsNotFreshSearch': True,
        'mockedSuccessIsNotFreshSearch': True,
    }


def annotate_section6(result):
    result.update(section6_annotation())
    return result


def main():
    if os.environ.get('QSB_CORE_CLASSIFY_ONLY') == '1':
        report = annotate_section6({
            'harnessRan': False,
            'network': None,
            'reason': os.environ.get('QSB_CORE_NOT_RUN_REASON')
            or 'Classification only. Bitcoin Core was not started.',
        })
        print(json.dumps(report, indent=2))
        return
    run_regtest()


def run_regtest():
    with tempfile.TemporaryDirectory(prefix='qsb-core-') as data:
        node = subprocess.Popen([str(BIN / 'bitcoind'), f'-datadir={data}',
            '-regtest', '-server', '-listen=0', '-connect=0', '-dnsseed=0',
            '-discover=0', '-persistmempool=0', '-fallbackfee=0.0002'],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        def rpc(method, *args, wallet=False, failure=False):
            command = [str(BIN / 'bitcoin-cli'), f'-datadir={data}', '-regtest']
            if wallet: command += ['-rpcwallet=qsb-validation']
            result = subprocess.run(command + [method] + [json.dumps(a) if not isinstance(a, str) else a for a in args], capture_output=True, text=True, timeout=60)
            if failure:
                assert result.returncode, f'{method} unexpectedly accepted invalid transaction'
                return result.stderr.strip()
            if result.returncode:
                raise RuntimeError(f'{method}: {result.stderr}')
            try: return json.loads(result.stdout)
            except json.JSONDecodeError: return result.stdout.strip()

        try:
            for _ in range(100):
                try:
                    info = rpc('getblockchaininfo')
                    break
                except RuntimeError: time.sleep(0.1)
            else: raise RuntimeError('Core did not start')
            assert info['chain'] == 'regtest'
            rpc('createwallet', 'qsb-validation')
            address = rpc('getnewaddress', wallet=True)
            destination = bytes.fromhex(rpc('getaddressinfo', address, wallet=True)['scriptPubKey'])
            rpc('generatetoaddress', 101, address)
            result = {'harnessRan': True, 'core': rpc('getnetworkinfo')['subversion'], 'network': 'regtest',
                      'tests': []}

            def mine(raw):
                block = rpc('generateblock', address, [raw])['hash']
                decoded = rpc('decoderawtransaction', raw)
                assert decoded['txid'] in rpc('getblock', block)['tx']
                return decoded['txid']

            def fund(script):
                utxo = rpc('listunspent', 1, 9999999, [], True, {'minimumAmount': 1}, wallet=True)[0]
                from decimal import Decimal
                value = int(Decimal(str(utxo['amount'])) * 100000000)
                tx = Transaction(version=1)
                tx.add_input(TxIn(bytes.fromhex(utxo['txid'])[::-1], utxo['vout']))
                tx.add_output(TxOut(100000, script))
                tx.add_output(TxOut(10000, b'\x51'))  # regtest-only helper, OP_TRUE
                tx.add_output(TxOut(value - 130000, destination))
                signed = rpc('signrawtransactionwithwallet', tx.serialize().hex(), wallet=True)
                assert signed['complete']
                txid = mine(signed['hex'])
                out = rpc('gettxout', txid, 0)
                assert out['confirmations'] == 1 and out['scriptPubKey']['hex'] == script.hex()
                return txid

            def spend(txid):
                tx = Transaction(version=1, locktime=500000000)
                tx.add_input(TxIn(bytes.fromhex(txid)[::-1], 1, b'', 0xfffffffe))
                tx.add_input(TxIn(bytes.fromhex(txid)[::-1], 0, b'', 0x80000000))
                tx.add_output(TxOut(90000, destination))
                return tx

            public = json.loads((ROOT / 'docs/gpu-validation/fixtures/wpkh/qsb_state.json').read_text())
            production = bytes.fromhex(public['full_script_hex'])
            txid = fund(production)
            result['tests'].append({'name': 'unmodified-production-lock-funding', 'passed': True,
                'scriptBytes': len(production), 'scriptSha256': hashlib.sha256(production).hexdigest(), 'txid': txid})
            invalid = spend(txid)
            rejection = rpc('generateblock', address, [invalid.serialize().hex()], failure=True)
            assert 'script' in rejection.lower(), rejection
            result['tests'].append({'name': 'unsolved-production-withdrawal-rejected', 'passed': True, 'reason': rejection})
            invalid.outputs = []
            rejection = rpc('generateblock', address, [invalid.serialize().hex()], failure=True)
            assert 'vout-empty' in rejection, rejection
            result['tests'].append({'name': 'zero-output-transaction-rejected', 'passed': True, 'reason': rejection})

            # Structural positive control only. THREE puzzle CHECKSIGVERIFYs are
            # replaced with OP_2DROP. Pin bind, HORS, both CHECKMULTISIGs stay real.
            b = QSBScriptBuilder(150, 8, 1, 7, 2, hash_mode='sha256')
            b.generate_keys()
            r = _valid_small_r_values()[0]
            pin = encode_der_sig(r, 1, 1)
            nonce = [encode_der_sig(r, 2, 1), encode_der_sig(r, 3, 1)]
            lock = b.build_full_script(pin, *nonce)
            structural = relax(lock)
            assert sum(a != z for a, z in zip(lock, structural)) == 3
            tx = spend(fund(structural))
            subsets = {0: [3, 17, 42, 66, 88, 101, 119, 140, 9], 1: [5, 20, 55, 70, 90, 110, 130, 15, 45]}
            indices = b.compute_witness_indices(subsets)
            witness = b''
            for ri in (1, 0):
                sc = find_and_delete(structural, nonce[ri])
                for i in subsets[ri]: sc = find_and_delete(sc, b.dummy_sigs[ri][i])
                key = recover_key(*parse_der(nonce[ri])[:2], tx.sighash(1, sc, 1))
                dummy = [recover_key(*parse_der(b.dummy_sigs[ri][i])[:2], 1 << 248) for i in subsets[ri]]
                assert key and all(dummy)
                witness += push_data(b'\x02' + b'\x00' * 32) + push_data(key)
                for pk in reversed(dummy): witness += push_data(pk)
                for i in reversed(subsets[ri][:8 if ri == 0 else 7]): witness += push_data(b.hors_secrets[ri][i])
                for i in reversed(indices[ri]): witness += push_number(i)
            key = recover_key(*parse_der(pin)[:2], tx.sighash(1, find_and_delete(structural, pin), 1))
            assert key
            tx.inputs[1].script_sig = witness + push_data(b'\x02' + b'\x00' * 32) + push_data(key)
            # Mutating the destination must break the real pinning signature.
            tampered = copy.deepcopy(tx)
            tampered.outputs[0].value -= 1
            rejection = rpc('generateblock', address, [tampered.serialize().hex()], failure=True)
            assert 'script' in rejection.lower(), rejection
            result['tests'].append({'name': 'structural-destination-amount-tamper-rejected', 'passed': True, 'reason': rejection})
            result['tests'].append({'name': 'PUZZLE-RELAXED-structural-spend', 'passed': True,
                'puzzleChecksBypassed': 3, 'txid': mine(tx.serialize().hex())})
            result['puzzleChecksBypassed'] = sum(test.get('puzzleChecksBypassed', 0) for test in result['tests'])
            annotate_section6(result)
            if result['section6Closed'] or result['fullProductionWithdrawalVerified'] or result['freshOptimizedWithdrawal']:
                raise SystemExit('Core report overclaims section 6')
            REPORT.parent.mkdir(parents=True, exist_ok=True)
            REPORT.write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps(result, indent=2))
        finally:
            try: rpc('stop')
            finally:
                try: node.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    node.kill()
                    node.wait()


if __name__ == '__main__':
    main()
