"""Fresh corrected-script offline regtest qualification, with disposable test keys.

Run in a network-disabled Docker container. Disposable test recovery and wallet remain in /proof. Only public-fixture.json
and export-*.json may leave that mount. Never use user wallet material here.
"""
import fcntl
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from decimal import Decimal

ROOT=Path(__file__).resolve().parents[2]
PROOF=Path('/proof')
BIN=Path('/bitcoin/bin')
sys.path.insert(0,str(ROOT/'worker/cpu'))
sys.path.insert(0,str(ROOT/'public/qsb'))
import bridge
from bitcoin_tx import Transaction, TxIn, TxOut, serialize_varint, SCRIPT_VERSION, classify_qsb_script
from handler import handler


def attach_helper_witness(original, signed):
    """Copy only the helper witness; Core cannot sign the bare QSB input."""
    assert original['version'] == signed['version']
    assert original['locktime'] == signed['locktime']
    assert original['vout'] == signed['vout']
    assert len(original['vin']) == len(signed['vin']) == 2
    tx = Transaction(original['version'], original['locktime'])
    for before, after in zip(original['vin'], signed['vin']):
        for key in ('txid', 'vout', 'sequence'):
            assert before[key] == after[key]
        tx.add_input(TxIn(bytes.fromhex(before['txid'])[::-1], before['vout'],
                         bytes.fromhex(before['scriptSig']['hex']), before['sequence']))
    assert original['vin'][0]['scriptSig']['hex'] == signed['vin'][0]['scriptSig']['hex'] == ''
    assert original['vin'][1]['scriptSig']['hex']
    assert not signed['vin'][1].get('txinwitness')
    witness = signed['vin'][0]['txinwitness']
    assert len(witness) == 2
    for output in original['vout']:
        tx.add_output(TxOut(int(Decimal(str(output['value'])) * 100000000),
                           bytes.fromhex(output['scriptPubKey']['hex'])))
    base = tx.serialize()
    serialized_witness = serialize_varint(len(witness))
    for item in witness:
        data = bytes.fromhex(item)
        serialized_witness += serialize_varint(len(data)) + data
    # Two inputs: the helper has a witness, the legacy QSB input has none.
    return (base[:4] + b'\x00\x01' + base[4:-4] + serialized_witness + b'\x00' + base[-4:]).hex()


def save(name,value):
    p=PROOF/name
    temporary=p.with_suffix('.tmp')
    temporary.write_text(json.dumps(value,indent=2)+'\n')
    temporary.chmod(0o600)
    temporary.replace(p)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('prepare', 'verify', 'export-round1', 'export-round2'):
        raise ValueError('Use prepare, export-round1, export-round2 or verify')
    if not Path('/.dockerenv').exists() or len(Path('/proc/net/route').read_text().splitlines()) > 1:
        raise ValueError('Requires Docker --network none')
    for interface in Path('/sys/class/net').iterdir():
        if (interface/'flags').is_file() and interface.name != 'lo' and int((interface/'flags').read_text(),16) & 1:
            raise ValueError('Active non-loopback interface')
    os.umask(0o077)
    PROOF.mkdir(exist_ok=True)
    lock=(PROOF/'.qualification.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if sys.argv[1] == 'prepare':
        if any(p.name != '.qualification.lock' for p in PROOF.iterdir()):
            raise ValueError('Fresh empty proof directory required; never recreate an old fixture')
        save('identity.json', {'format':'qsb-corrected-core-test-v1','scriptVersion':SCRIPT_VERSION,'testOnly':True})
    else:
        if json.loads((PROOF/'identity.json').read_text()) != {'format':'qsb-corrected-core-test-v1','scriptVersion':SCRIPT_VERSION,'testOnly':True}:
            raise ValueError('Fixture identity mismatch')
        if (PROOF/'verified-withdrawal.json').exists() or (PROOF/'verification-started.json').exists():
            raise ValueError('Withdrawal already attempted; reconcile locally, never repeat blindly')
    data=PROOF/'node'; data.mkdir(exist_ok=True)
    pidfile=data/'owned-core.pid'
    node=subprocess.Popen([str(BIN/'bitcoind'),f'-pid={pidfile}',f'-datadir={data}','-regtest','-server','-networkactive=0','-listen=0','-connect=0','-dnsseed=0','-discover=0','-persistmempool=0','-fallbackfee=0.0002'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    def rpc(method,*args,wallet=False):
        if node.poll() is not None or not pidfile.exists() or pidfile.read_text().strip() != str(node.pid):
            raise RuntimeError('Owned Core child exited; refusing RPC')
        command=[str(BIN/'bitcoin-cli'),f'-datadir={data}','-regtest']
        if wallet:command+=['-rpcwallet=qsb-proof']
        r=subprocess.run(command+[method]+[a if isinstance(a,str) else json.dumps(a) for a in args],capture_output=True,text=True,timeout=60)
        if r.returncode:raise RuntimeError(f'{method} failed: {r.stderr.strip()}')
        try:return json.loads(r.stdout)
        except json.JSONDecodeError:return r.stdout.strip()
    try:
        for _ in range(100):
            try:
                assert rpc('getblockchaininfo')['chain']=='regtest'
                assert rpc('getnetworkinfo')['networkactive'] is False
                assert rpc('getconnectioncount') == 0
                break
            except RuntimeError:time.sleep(.1)
        else:raise RuntimeError('Core startup failed')
        if 'qsb-proof' not in rpc('listwallets'):
            if any(w['name']=='qsb-proof' for w in rpc('listwalletdir')['wallets']):rpc('loadwallet','qsb-proof')
            else:rpc('createwallet','qsb-proof')
        fixture=PROOF/'public-fixture.json'
        if sys.argv[1]=='prepare':
            address=rpc('getnewaddress',wallet=True)
            destination=bytes.fromhex(rpc('getaddressinfo',address,wallet=True)['scriptPubKey'])
            rpc('generatetoaddress',101,address)
            previous=os.getcwd()
            try:
                os.chdir(PROOF)
                generated=json.loads(bridge.generate())
            finally:os.chdir(previous)
            assert classify_qsb_script(json.loads(generated['publicStateJson'])) == SCRIPT_VERSION
            save('recovery.json',{'stateJson':generated['stateJson']})
            u=rpc('listunspent',1,9999999,[],True,{'minimumAmount':1},wallet=True)[0]
            amount=int(Decimal(str(u['amount']))*100000000)
            tx=Transaction(version=1)
            tx.add_input(TxIn(bytes.fromhex(u['txid'])[::-1],u['vout']))
            tx.add_output(TxOut(100000,bytes.fromhex(generated['scriptHex'])))
            tx.add_output(TxOut(10000,destination))
            tx.add_output(TxOut(amount-130000,destination))
            signed=rpc('signrawtransactionwithwallet',tx.serialize().hex(),wallet=True)
            assert signed['complete']
            block=rpc('generateblock',address,[signed['hex']])['hash']
            txid=rpc('decoderawtransaction',signed['hex'])['txid']
            assert txid in rpc('getblock',block)['tx']
            public={'scriptVersion':SCRIPT_VERSION,'testOnly':True,'network':'regtest','core':rpc('getnetworkinfo')['subversion'],'miningAddress':address,
                'publicStateJson':generated['publicStateJson'],'scriptHex':generated['scriptHex'],'scriptHash':generated['scriptHash'],
                'fundingRawTx':signed['hex'],'fundingBlock':block,
                'manifest':{'funding':{'txid':txid,'vout':0,'value':'100000'},'helper':{'txid':txid,'vout':1,'value':'10000'},'destination':address,'outputScript':destination.hex(),'outputValue':'90000','fee':'20000'}}
            assert rpc('gettxout',txid,0)['scriptPubKey']['hex']==generated['scriptHex']
            save('public-fixture.json',public)
            save('export-pinning.json', export(public, 'pinning'))
            print(json.dumps({'network':'regtest','fundingTxid':txid,'scriptBytes':len(generated['scriptHex'])//2,'scriptHash':generated['scriptHash'],'fundingConfirmed':True}))
        elif sys.argv[1].startswith('export-'):
            public=json.loads(fixture.read_text())
            solution=json.loads((PROOF/'solution.json').read_text())
            check_pin(public, solution)
            stage=sys.argv[1][7:]
            save(sys.argv[1]+'.json', export(public,stage,solution))
            print(json.dumps({'exported':stage,'scriptVersion':SCRIPT_VERSION}))
        elif sys.argv[1]=='verify':
            public=json.loads(fixture.read_text())
            recovery=json.loads((PROOF/'recovery.json').read_text())
            solution=json.loads((PROOF/'solution.json').read_text())
            if bridge.validate(recovery['stateJson']) != public['scriptHash']:
                raise ValueError('Local test state does not match public fixture')
            check_pin(public, solution)
            for stage in ('round1','round2'):
                values=solution[stage]
                record='indices='+','.join(str(149-i) for i in sorted(values))
                event=export_event(public,stage,solution)
                verdict=handler({**event,'action':'verify','candidates':[record]})
                if not verdict.get('valid') or verdict.get('indices') != sorted(values):
                    raise ValueError('CPU rejected '+stage)
            for key in ('funding','helper'):
                out=public['manifest'][key]
                current=rpc('gettxout',out['txid'],out['vout'])
                expected=public['scriptHex'] if key == 'funding' else public['manifest']['outputScript']
                if not current or current['scriptPubKey']['hex'] != expected or int(Decimal(str(current['value']))*100000000) != int(out['value']):
                    raise ValueError('Fixture output spent or modified')
            previous=os.getcwd()
            try:
                os.chdir(PROOF)
                raw=bridge.assemble(recovery['stateJson'],json.dumps(public['manifest']),json.dumps(solution))
            finally:os.chdir(previous)
            signed=rpc('signrawtransactionwithwallet',raw,wallet=True)
            original=rpc('decoderawtransaction',raw)
            wallet_decoded=rpc('decoderawtransaction',signed['hex'])
            signed['hex']=attach_helper_witness(original,wallet_decoded)
            # Wallet policy completeness is not consensus acceptance for bare QSB.
            # generateblock below enforces unmodified full Bitcoin Core consensus.
            decoded=rpc('decoderawtransaction',signed['hex'])
            assert decoded['txid']==original['txid']
            assert decoded['vin'][1]==original['vin'][1]
            assert len(decoded['vin'])==2 and len(decoded['vout'])==1
            assert decoded['vin'][0].get('txinwitness')
            save('verification-started.json',{'txid':decoded['txid'],'rawTx':signed['hex'],'scriptHash':public['scriptHash']})
            block=rpc('generateblock',public['miningAddress'],[signed['hex']])['hash']
            assert decoded['txid'] in rpc('getblock',block)['tx']
            save('verified-withdrawal.json',{'network':'regtest','freshOfflineCoreWithdrawalVerified':True,'core':rpc('getnetworkinfo')['subversion'],'txid':decoded['txid'],'block':block,'rawTx':signed['hex'],'scriptHash':public['scriptHash'],'puzzleChecksBypassed':0})
            print(json.dumps({'freshOfflineCoreWithdrawalVerified':True,'txid':decoded['txid'],'block':block}))
        else:raise ValueError('Use prepare or verify')
    finally:
        try:
            if node.poll() is None and pidfile.exists() and pidfile.read_text().strip() == str(node.pid): rpc('stop')
        finally:
            try:node.wait(timeout=15)
            except subprocess.TimeoutExpired:node.kill();node.wait()

def export_event(public, stage, solution=None):
    if public.get('scriptVersion') != SCRIPT_VERSION or classify_qsb_script(json.loads(public['publicStateJson'])) != SCRIPT_VERSION:
        raise ValueError('Corrected public fixture required')
    event={'action':'export','scriptVersion':SCRIPT_VERSION,'publicStateJson':public['publicStateJson'],'manifest':public['manifest'],'stage':stage}
    if solution:
        event.update({k:solution[k] for k in ('sequence','locktime')})
    return event


def export(public, stage, solution=None):
    event=export_event(public,stage,solution)
    return {'request':event,'export':handler(event)}


def check_pin(public, solution):
    event=export_event(public,'pinning')
    record='sequence='+str(solution['sequence'])+'\nlocktime='+str(solution['locktime'])
    result=handler({**event,'action':'verify','candidates':[record]})
    if not result.get('valid'):
        raise ValueError('CPU rejected pinning solution')


if __name__=='__main__':
    if sys.flags.optimize:
        raise RuntimeError('Assertions must remain enabled')
    main()

