"""Native range boundary tests and full uninstrumented worker throughput."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path('/workspace')
LOGS = ROOT / 'logs'

def run(name, command, case='wpkh'):
    start = time.monotonic()
    r = subprocess.run([str(x) for x in command], cwd=ROOT/'fixtures'/case,
        capture_output=True, text=True, timeout=180)
    (LOGS/f'{name}.log').write_text(r.stdout+r.stderr)
    if r.returncode: raise RuntimeError(f'{name}: exit {r.returncode}')
    return {'name':name,'elapsedSeconds':time.monotonic()-start,'command':command,'case':case}

def main():
    runs=[]
    for name, seq, lt, count in [('start',2147483648,500000000,257),
        ('middle',2147483649,516777216,7), ('end',4294967295,1744599993,7)]:
        runs.append(run('pin-'+name,[str(ROOT/'bin/pin-trace'),'pinning.bin','0','1','0','single_hash',
            f'seq_start={seq}','seq_count=1',f'lt_start={lt}',f'lt_count={count}']))
    for ri in (1,2):
        for name, start, count in [('start',0,7),('adjacent',7,7),('large',2**40+123,7),('end',82947113349100-7,7)]:
            runs.append(run(f'round{ri}-{name}',[str(ROOT/'bin/subset-trace'),f'digest_r{ri}.bin','0','2147483648','500000000','1','0','single_hash',f'rank_start={start}',f'rank_count={count}']))
    (LOGS/'range-runs.json').write_text(json.dumps(runs,indent=2)+'\n')
    print('Trace runs completed',flush=True)
    Path('/opt/qsb').mkdir(exist_ok=True, parents=True)
    for name in ('pinning','subset'):
        p=Path('/opt/qsb')/name
        if not p.exists(): p.symlink_to(ROOT/'bin'/name)
    sys.path.insert(0,str(ROOT/'worker'))
    from handler import handler
    reports=[]
    for stage, filename, attempts in [('pinning','pinning.bin',[0,74,75,161061273599]),
        ('round1','digest_r1.bin',[0,4944033]),('round2','digest_r2.bin',[0,4944033])]:
        raw=(ROOT/'fixtures/wpkh'/filename).read_bytes()
        for attempt in attempts:
            event={'input':{'protocol':'qsb-config-a-v1','stage':stage,'searchVersion':'ranked-v1',
                'kernelCommit':'2791ed0588f5014ccd688d48ba5502df2879f2f1','manifestHash':'a'*64,
                'parameterBase64':base64.b64encode(raw).decode(),'parameterSha256':hashlib.sha256(raw).hexdigest(),
                'attempt':attempt,'sequence':2147483648,'locktime':500000000}}
            report=handler(event)
            reports.append(report)
            (LOGS/'worker-ranges.json').write_text(json.dumps(reports,indent=2)+'\n')
            print(json.dumps(report),flush=True)
            assert report['status']=='completed', report
            if not report['candidates']: assert report['checkpoint']=='range-complete'

if __name__=='__main__':main()
