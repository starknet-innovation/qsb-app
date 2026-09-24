"""Public synthetic GPU differential; no funding, wallet, provider or deployment API."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import time
from test_pin_recovery import G, N, mul
from sha_midstate import midstate

IV=(0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19)
TRACE=re.compile(r'^QSB_TRACE seq=(\d+) lt=(\d+) ri=([01]) hash=(infinity|[0-9a-f]{64})$')


def expected(suffix, sequence, locktime, nri=1, rscalar=1, prefix=b'', seq_offset=0):
    message=bytearray(suffix)
    message[seq_offset:seq_offset+4]=struct.pack('<I',sequence)
    message[-8:-4]=struct.pack('<I',locktime)
    z=int.from_bytes(hashlib.sha256(hashlib.sha256(prefix+message).digest()).digest(),'big')
    out={}
    for ri in (0,1):
        pt=mul((z*nri+(rscalar if ri==0 else -rscalar))%N)
        if pt is None:
            out[ri]='infinity';continue
        pub=bytes([2+(pt[1]&1)])+pt[0].to_bytes(32,'big')
        out[ri]=hashlib.sha256(pub).hexdigest()
    return out


def prepare(source, out):
    if out.exists():raise ValueError('Use a fresh directory')
    shutil.copytree(source/'pinning',out/'pinning')
    text=(out/'pinning/pinning.cu').read_text()
    needle='            vv=gpu_bench_valid_words(hs);'
    if text.count(needle)!=1:raise ValueError('Trace context drift')
    trace='''            if (active) printf("QSB_TRACE seq=%u lt=%u ri=%d hash=%08x%08x%08x%08x%08x%08x%08x%08x\\n",
                seq_value, start_lt+(uint32_t)idx, ri, hs[0],hs[1],hs[2],hs[3],hs[4],hs[5],hs[6],hs[7]);
'''
    diagnostic=text.replace(needle,trace+needle)
    host='    if (!qsb_recover_hash(d2, recid, grp, ctx, order, nri, Ru2, hh)) return 0;'
    if diagnostic.count(host)!=1:raise ValueError('Host trace context drift')
    diagnostic=diagnostic.replace(host, '''    if (!qsb_recover_hash(d2, recid, grp, ctx, order, nri, Ru2, hh)) {
        printf("QSB_TRACE seq=%u lt=%u ri=%d hash=infinity\\n",seq,lt,recid);return 0;
    }
    printf("QSB_TRACE seq=%u lt=%u ri=%d hash=",seq,lt,recid);
    for(int j=0;j<32;j++)printf("%02x",hh[j]);printf("\\n");''')
    (out/'pinning/pinning_trace.cu').write_text(diagnostic)
    cases=[]
    for sl in (12,75):
        suffix=bytes((i*17+3)%256 for i in range(sl-4))+struct.pack('<I',1)
        raw=struct.pack('>8I',*IV)+struct.pack('<I',sl)+suffix+struct.pack('<III',sl,0,sl-8)
        raw+=(1).to_bytes(32,'little')+G[0].to_bytes(32,'little')+G[1].to_bytes(32,'little')
        (out/f'params-{sl}.bin').write_bytes(raw)
        for seq,count,lt,n in [(2147483648,1,500000000,1),(2147483649,1,500000000,129),
                              (2147483650,2,500000256,257),(4294967295,1,4294967040,256)]:
            want={}
            for s in range(seq,seq+count):
                for t in range(lt,lt+n):
                    for ri,h in expected(suffix,s,t).items():want[f'{s}:{t}:{ri}']=h
            cases.append({'name':f'sl{sl}-seq{seq}','params':f'params-{sl}.bin','sequence':seq,
                          'sequences':count,'locktime':lt,'locktimes':n,'expected':want})
    # Exact upstream FAST_TAIL geometry, with a real 155-block public prefix.
    prefix=bytes((i*29+7)%256 for i in range(9920))
    state=midstate(prefix)
    suffix=bytes((i*13+11)%256 for i in range(71))+struct.pack('<I',1)
    for nri,rscalar in [(1,1),(N-1,3)]:
        point=mul(rscalar);name='fast-tail-unit' if nri==1 else 'fast-tail-order-edge'
        raw=struct.pack('>8I',*state)+struct.pack('<I',75)+suffix+struct.pack('<III',9995,31,67)
        raw+=nri.to_bytes(32,'little')+point[0].to_bytes(32,'little')+point[1].to_bytes(32,'little')
        (out/f'{name}.bin').write_bytes(raw)
        seq=2147483680;lt=500000768;count=2;n=129
        want={}
        for s in range(seq,seq+count):
            for t in range(lt,lt+n):
                for ri,h in expected(suffix,s,t,nri,rscalar,prefix,31).items():want[f'{s}:{t}:{ri}']=h
        cases.append({'name':name,'params':f'{name}.bin','sequence':seq,'sequences':count,
                      'locktime':lt,'locktimes':n,'expected':want})
    # Force P=+R / P=-R with public constants derived from the synthetic hash.
    # This changes no predicate and solves no SHA preimage; it exercises the
    # actual denominator detector and CPU doubling/infinity handoff.
    for sign in (1,-1):
        seq=2147483660;lt=500000512;nri=7
        suffix=bytes(8)+struct.pack('<I',1)
        message=struct.pack('<II',seq,lt)+struct.pack('<I',1)
        z=int.from_bytes(hashlib.sha256(hashlib.sha256(message).digest()).digest(),'big')
        rscalar=(sign*z*nri)%N;point=mul(rscalar)
        if point is None:raise ValueError('Unexpected zero scalar')
        name=f'exception-sign{sign}'
        raw=struct.pack('>8I',*IV)+struct.pack('<I',12)+suffix+struct.pack('<III',12,0,4)
        raw+=nri.to_bytes(32,'little')+point[0].to_bytes(32,'little')+point[1].to_bytes(32,'little')
        (out/f'{name}.bin').write_bytes(raw)
        want={f'{seq}:{lt}:{ri}':h for ri,h in expected(suffix,seq,lt,nri,rscalar).items()}
        cases.append({'name':name,'params':f'{name}.bin','sequence':seq,'sequences':1,
                      'locktime':lt,'locktimes':1,'expected':want})
    receipt={'scope':'synthetic-public-generic-specialized-exception-pinning','cases':cases,
             'sourceSha256':hashlib.sha256(text.encode()).hexdigest(),
             'traceSourceSha256':hashlib.sha256((out/'pinning/pinning_trace.cu').read_bytes()).hexdigest(),
             'freshWithdrawal':False,'gpuExecuted':False}
    (out/'plan.json').write_text(json.dumps(receipt,indent=2)+'\n')
    return receipt


def check_trace(stdout, case):
    got={}
    for line in stdout.splitlines():
        m=TRACE.fullmatch(line)
        if not m:
            if 'QSB_TRACE' in line:raise ValueError('Malformed trace')
            continue
        seq,lt,ri,h=m.groups();key=f'{seq}:{lt}:{ri}'
        if key in got:raise ValueError('Duplicate trace candidate')
        got[key]=h
    if got!=case['expected']:
        missing=set(case['expected'])-set(got);extra=set(got)-set(case['expected'])
        wrong=sum(got.get(k)!=v for k,v in case['expected'].items() if k in got)
        raise ValueError(f'GPU mismatch: missing={len(missing)} extra={len(extra)} wrong={wrong}')
    return len(got)


def execute(out):
    plan=json.loads((out/'plan.json').read_text())
    if (out/'native-results.json').exists():raise ValueError('Do not overwrite prior execution')
    (out/'bin').mkdir()
    for source,binary in [('pinning.cu','pinning'),('pinning_trace.cu','pinning-trace')]:
        result=subprocess.run(['nvcc','-O3','-arch=sm_89','-std=c++17',source,'-o',str((out/'bin'/binary).resolve()),'-lcrypto','-lm'],cwd=out/'pinning',capture_output=True,text=True,timeout=300)
        (out/f'{binary}-compile.log').write_text(result.stdout+result.stderr)
        if result.returncode:raise RuntimeError(f'{binary} compile failed')
    records=[]
    for case in plan['cases']:
        for binary in ('pinning','pinning-trace'):
            cwd=out/f"{case['name']}-{binary}";cwd.mkdir()
            command=[str((out/'bin'/binary).resolve()),str((out/case['params']).resolve()),'0',
                     str(case['sequence']),str(case['sequences']),str(case['locktime']),str(case['locktimes'])]
            start=time.monotonic()
            r=subprocess.run(command,cwd=cwd,capture_output=True,text=True,timeout=120)
            (cwd/'stdout.log').write_text(r.stdout);(cwd/'stderr.log').write_text(r.stderr)
            if r.returncode:raise RuntimeError(f'{cwd.name} failed: {r.returncode}')
            marker=f"QSB_RANGE_DRAINED candidates={case['sequences']*case['locktimes']}"
            if r.stdout.splitlines().count(marker)!=1:raise ValueError('Missing/excess drain receipt')
            matches=check_trace(r.stdout,case) if binary=='pinning-trace' else None
            records.append({'case':case['name'],'binary':binary,'matchedHashes':matches,'seconds':time.monotonic()-start})
            (out/'native-results.partial.json').write_text(json.dumps(records,indent=2)+'\n')
    receipt={'scope':plan['scope'],'runs':records,'freshWithdrawal':False,
             'binaries':{n:hashlib.sha256((out/'bin'/n).read_bytes()).hexdigest() for n in ('pinning','pinning-trace')}}
    (out/'native-results.json').write_text(json.dumps(receipt,indent=2)+'\n')

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('mode',choices=['prepare','execute'])
    ap.add_argument('--source',type=Path);ap.add_argument('--out',type=Path,required=True);args=ap.parse_args()
    if args.mode=='prepare':
        if args.source is None:ap.error('--source required')
        print(json.dumps({'cases':len(prepare(args.source,args.out)['cases']),'gpuExecuted':False}))
    else:execute(args.out.resolve())
