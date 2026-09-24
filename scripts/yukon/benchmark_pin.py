"""Matched public pinning ranges on one GPU; fixed historical/candidate binaries."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import time

HASHES={'baseline':'186d68751649a81e41d16079c80bb3725b0470d7e4debe5dc88e66578d633f13',
        'candidate':'88cf46c45a63972e31af5f1c835a3b4088d6ea76af4b69e7bb0d7227d1562263'}
COUNTS=(1<<27,1<<29)

def summarize(records):
    summaries={}
    for layout in sorted(set(r['layout'] for r in records)):
        rates={}
        for solver in HASHES:
            slopes=[]
            for rep in range(3):
                rows=[r for r in records if r['layout']==layout and r['solver']==solver and r['rep']==rep]
                if len(rows)!=2 or {r['count'] for r in rows}!=set(COUNTS):raise ValueError('Incomplete paired samples')
                by={r['count']:r['wallSeconds'] for r in rows};delta=by[COUNTS[1]]-by[COUNTS[0]]
                if delta<=0:raise ValueError('Nonpositive timing slope; increase sample range')
                slopes.append((COUNTS[1]-COUNTS[0])/delta)
            rates[solver]={'slopesCandidatesPerSecond':slopes,'medianCandidatesPerSecond':statistics.median(slopes)}
        summaries[layout]={'rates':rates,'medianThroughputChangePercent':100*(rates['candidate']['medianCandidatesPerSecond']/rates['baseline']['medianCandidatesPerSecond']-1)}
    return summaries

def execute(inputs,out,production_units=False):
    if out.exists():raise ValueError('Fresh output directory required')
    for solver,want in HASHES.items():
        if hashlib.sha256((inputs/solver).read_bytes()).hexdigest()!=want:raise ValueError('Frozen binary mismatch')
    requests=json.loads((inputs/'requests.json').read_text());out.mkdir();records=[]
    counts=(1244600000,) if production_units else COUNTS
    sequences=16 if production_units else 1
    env={k:v for k,v in os.environ.items() if k in {'PATH','LD_LIBRARY_PATH','CUDA_VISIBLE_DEVICES'}}
    for layout,request in enumerate(requests):
        raw=base64.b64decode(request['parameterBase64'],validate=True)
        if hashlib.sha256(raw).hexdigest()!=request['parameterSha256']:raise ValueError('Parameter mismatch')
        for rep in range(3):
            for count in counts:
                for solver in (('baseline','candidate') if rep%2==0 else ('candidate','baseline')):
                    label=f'layout{layout}-rep{rep}-n{count}-{solver}';cwd=out/label;cwd.mkdir();(cwd/'params.bin').write_bytes(raw)
                    cmd=[str((inputs/solver).resolve()),'params.bin','0']
                    if solver=='candidate':cmd+=['2147483648',str(sequences),'500000000',str(count)]
                    else:cmd+=['1','0','single_hash','seq_start=2147483648',f'seq_count={sequences}','lt_start=500000000',f'lt_count={count}']
                    start=time.monotonic();r=subprocess.run(cmd,cwd=cwd,env=env,capture_output=True,text=True,timeout=180);elapsed=time.monotonic()-start
                    (cwd/'stdout.txt').write_text(r.stdout);(cwd/'stderr.txt').write_text(r.stderr)
                    if r.returncode or 'CUDA error' in r.stdout+r.stderr:raise ValueError('Benchmark process failed')
                    if solver=='candidate':
                        if r.stdout.splitlines().count(f'QSB_RANGE_DRAINED candidates={count*sequences}')!=1:raise ValueError('Missing candidate drain count')
                    elif not re.search(r'\bDone: '+str(count*sequences//1000000)+r'M\b',r.stdout):raise ValueError('Historical baseline completion disagrees')
                    records.append({'layout':layout,'rep':rep,'count':count,'sequences':sequences,'solver':solver,'wallSeconds':elapsed,'parameterSha256':request['parameterSha256'],
                                    'hitFiles':{p.name:p.read_text() for p in (cwd/'results').glob('*hit*.txt')}})
                    (out/'partial.json').write_text(json.dumps(records,indent=2)+'\n')
    summary=summarize(records) if not production_units else {layout:{solver:{'wallSeconds':[r['wallSeconds'] for r in records if r['layout']==layout and r['solver']==solver], 'medianWallSeconds':statistics.median(r['wallSeconds'] for r in records if r['layout']==layout and r['solver']==solver)} for solver in HASHES} for layout in range(len(requests))}
    (out/'results.json').write_text(json.dumps({'binaryHashes':HASHES,'runs':records,'summary':summary,'productionUnits':production_units,'freshWithdrawal':False,'scope':'interleaved same-GPU unfunded public full-script contexts; process wall-time slopes'},indent=2)+'\n')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--inputs',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--production-units',action='store_true');a=p.parse_args();execute(a.inputs.resolve(),a.out.resolve(),a.production_units)
