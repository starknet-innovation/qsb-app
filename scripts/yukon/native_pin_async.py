"""Native diagnostic injection into asynchronous CUDA expressions, never release code."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

APIS = {'cudaMemcpyAsync','cudaMemsetAsync','cudaEventRecord','cudaEventSynchronize',
        'cudaStreamWaitEvent','cudaStreamCreateWithFlags','cudaStreamCreateWithPriority',
        'cudaEventCreateWithFlags','cudaDeviceGetStreamPriorityRange','cudaHostAlloc'}
HEADER = r'''#pragma once
#include <cuda_runtime.h>
#include <stdio.h>
#include <stdlib.h>
static cudaError_t qsb_async_diagnostic(cudaError_t result, const char *site) {
    static unsigned ordinal=0; ++ordinal;
    fprintf(stderr,"QSB_ASYNC_DIAGNOSTIC ordinal=%u site=%s\n",ordinal,site);
    const char *value=getenv("QSB_DIAGNOSTIC_ASYNC_ORDINAL");
    if(value && strtoul(value,NULL,10)==ordinal)return cudaErrorUnknown;
    return result;
}
'''
PATTERN=re.compile(r'^QSB_ASYNC_DIAGNOSTIC ordinal=(\d+) site=(.+)$',re.M)

def instrument(text, filename):
    hidden=re.sub(r'/\*.*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"',lambda m: ''.join('\n' if c=='\n' else ' ' for c in m[0]),text,flags=re.S)
    sites=[]
    for m in re.finditer(r'\b(cuda[A-Za-z0-9_]+)\s*\(',hidden):
        if m[1] not in APIS:continue
        start=m.start();end=m.end();depth=1
        while depth:
            if end>=len(hidden):raise ValueError('Unclosed CUDA expression')
            depth+=(hidden[end]=='(')-(hidden[end]==')');end+=1
        sites.append((start,end,f'{filename}:{hidden[:start].count(chr(10))+1}:{m[1]}'))
    for start,end,label in reversed(sites):
        text=text[:start]+f'qsb_async_diagnostic({text[start:end]}, "{label}")'+text[end:]
    return text,[label for _,_,label in sites]

def prepare(source,params,out):
    if out.exists():raise ValueError('Fresh directory required')
    shutil.copytree(source/'pinning',out/'pinning');shutil.copyfile(params,out/'params.bin')
    inventory={}
    for name in ('pinning.cu','SlotReadback.h','PriorityPipeline.h'):
        p=out/'pinning'/name
        text,sites=instrument(p.read_text(),name)
        if not sites:raise ValueError('Missing diagnostic sites')
        p.write_text('#include "qsb_async_diagnostic.h"\n'+text);inventory[name]=sites
    (out/'pinning/qsb_async_diagnostic.h').write_text(HEADER)
    plan={'scope':'synthetic asynchronous CUDA error after real call, diagnostic only',
          'sites':inventory,'sourceSha256':hashlib.sha256((source/'pinning/pinning.cu').read_bytes()).hexdigest(),
          'freshWithdrawal':False}
    (out/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')

def check(r, ordinal):
    seen=[int(i) for i,_ in PATTERN.findall(r.stderr)]
    if not r.returncode or seen!=list(range(1,ordinal+1)) or 'QSB_RANGE_DRAINED' in r.stdout:
        raise ValueError('Async failure did not stop without completion at selected call')

def execute(out):
    if (out/'async').exists():raise ValueError('Do not overwrite prior execution')
    r=subprocess.run(['nvcc','-O3','-arch=sm_89','-std=c++17','pinning.cu','-o',str(out/'async'),'-lcrypto','-lm'],cwd=out/'pinning',capture_output=True,text=True,timeout=300)
    (out/'compile.txt').write_text(r.stdout+r.stderr)
    if r.returncode:raise RuntimeError('Compile failed')
    records=[]
    def run(ordinal):
        cwd=out/f'fault-{ordinal}';cwd.mkdir()
        env=dict(os.environ);env.pop('QSB_DIAGNOSTIC_ASYNC_ORDINAL',None)
        if ordinal:env['QSB_DIAGNOSTIC_ASYNC_ORDINAL']=str(ordinal)
        r=subprocess.run([str(out/'async'),str(out/'params.bin'),'0','2147483648','2','500000000','1'],cwd=cwd,env=env,capture_output=True,text=True,timeout=120)
        (cwd/'stdout.txt').write_text(r.stdout);(cwd/'stderr.txt').write_text(r.stderr)
        records.append({'ordinal':ordinal,'returncode':r.returncode})
        (out/'partial.json').write_text(json.dumps(records,indent=2)+'\n')
        return r
    baseline=run(0);sites=PATTERN.findall(baseline.stderr)
    if baseline.returncode or not sites or baseline.stdout.splitlines().count('QSB_RANGE_DRAINED candidates=2')!=1:raise ValueError('Baseline failed')
    for ordinal in range(1,len(sites)+1):check(run(ordinal),ordinal)
    (out/'results.json').write_text(json.dumps({'scope':'two sequences, one candidate each; diagnostic error returns after real calls',
        'runs':records,'reachedSites':[{'ordinal':int(i),'site':s} for i,s in sites],
        'binarySha256':hashlib.sha256((out/'async').read_bytes()).hexdigest(),
        'freshWithdrawal':False,'rangeCreditEligible':False},indent=2)+'\n')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['prepare','execute']);p.add_argument('--source',type=Path);p.add_argument('--params',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    if a.mode=='prepare':
        if a.source is None or a.params is None:p.error('--source and --params required')
        prepare(a.source,a.params,a.out)
    else:execute(a.out.resolve())
