"""Isolated diagnostic binaries; never changes the release predicate or source."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

CUDA_MACRO = '#define QSB_CUDA(call) qsb_require_host((call) == cudaSuccess, #call)'
INSTRUMENT = r'''#include <cuda_runtime.h>
#include <stdio.h>
#include <stdlib.h>
static cudaError_t qsb_diagnostic_cuda(cudaError_t result, const char *site) {
    static unsigned ordinal = 0;
    ++ordinal;
    fprintf(stderr, "QSB_CUDA_DIAGNOSTIC ordinal=%u site=%s\n", ordinal, site);
    const char *value = getenv("QSB_DIAGNOSTIC_FAIL_ORDINAL");
    if (value && strtoul(value, NULL, 10) == ordinal) return cudaErrorUnknown;
    return result;
}
#define QSB_CUDA(call) qsb_require_host(qsb_diagnostic_cuda((call), #call) == cudaSuccess, #call)
'''
ORDINAL = re.compile(r'^QSB_CUDA_DIAGNOSTIC ordinal=(\d+) site=(.+)$', re.M)


def diagnostic_sources(text):
    needle = '            vv=gpu_bench_valid_words(hs);'
    if text.count(needle) != 1 or text.count(CUDA_MACRO) != 1:
        raise ValueError('Diagnostic source context drift')
    if 'QSB_DIAGNOSTIC' in text:
        raise ValueError('Source already contains diagnostics')
    return {'overflow': text.replace(needle, '            vv=1; // DIAGNOSTIC forced nomination, not a puzzle hit'),
            'cuda': text.replace(CUDA_MACRO, INSTRUMENT)}


def check_failure(result, ordinal):
    seen = [int(n) for n, _ in ORDINAL.findall(result.stderr)]
    if result.returncode != 2 or seen != list(range(1, ordinal + 1)):
        raise ValueError('Failure did not stop at the requested CUDA call')
    if 'QSB_RANGE_DRAINED' in result.stdout or 'QSB_RANGE_INCOMPLETE' not in result.stderr:
        raise ValueError('Failure completion contract violated')


def prepare(source, params, out):
    if out.exists(): raise ValueError('Use a fresh directory')
    text = (source/'pinning/pinning.cu').read_text()
    variants = diagnostic_sources(text)
    shutil.copytree(source/'pinning', out/'pinning')
    shutil.copyfile(params, out/'params.bin')
    for name, code in variants.items():
        (out/'pinning'/f'pinning_{name}.cu').write_text(code)
    receipt = {'scope': 'diagnostic-only-forced-nominations-and-synthetic-CUDA-errors',
               'normalSourceSha256': hashlib.sha256(text.encode()).hexdigest(),
               'diagnostics': {n: hashlib.sha256(c.encode()).hexdigest() for n,c in variants.items()},
               'paramsSha256': hashlib.sha256((out/'params.bin').read_bytes()).hexdigest(),
               'freshWithdrawal': False}
    (out/'plan.json').write_text(json.dumps(receipt, indent=2)+'\n')


def execute(out):
    if (out/'bin').exists(): raise ValueError('Do not overwrite an execution')
    (out/'bin').mkdir()
    for name in ('normal','overflow','cuda'):
        source = 'pinning.cu' if name == 'normal' else f'pinning_{name}.cu'
        r = subprocess.run(['nvcc','-O3','-arch=sm_89','-std=c++17',source,'-o',str(out/'bin'/name),'-lcrypto','-lm'], cwd=out/'pinning', capture_output=True,text=True,timeout=300)
        (out/f'compile-{name}.txt').write_text(r.stdout+r.stderr)
        if r.returncode: raise RuntimeError(f'{name} compilation failed')
    records=[]
    def run(name, count, ordinal=0, memcheck=False):
        label=f'{name}-{count}-{ordinal}' + ('-memcheck' if memcheck else '')
        cwd=out/label;cwd.mkdir()
        command=[str(out/'bin'/name),str(out/'params.bin'),'0','2147483648','1','500000000',str(count)]
        if memcheck: command=['compute-sanitizer','--tool','memcheck','--error-exitcode','99']+command
        env=dict(os.environ);env.pop('QSB_DIAGNOSTIC_FAIL_ORDINAL',None)
        if ordinal: env['QSB_DIAGNOSTIC_FAIL_ORDINAL']=str(ordinal)
        r=subprocess.run(command,cwd=cwd,env=env,capture_output=True,text=True,timeout=120)
        (cwd/'stdout.txt').write_text(r.stdout);(cwd/'stderr.txt').write_text(r.stderr)
        records.append({'case':label,'returncode':r.returncode})
        (out/'partial.json').write_text(json.dumps(records,indent=2)+'\n')
        return r
    for count in (1,63,64,65,1024,1025):
        r=run('overflow',count)
        if count <= 64:
            if r.returncode or r.stdout.splitlines().count(f'QSB_RANGE_DRAINED candidates={count}')!=1:
                raise ValueError('In-capacity diagnostic did not drain')
        elif not r.returncode or 'QSB_RANGE_DRAINED' in r.stdout or 'capacity' not in r.stderr.lower():
            raise ValueError('Overflow did not fail closed')
    r=run('overflow',1025,memcheck=True)
    if not r.returncode or r.returncode==99 or 'QSB_RANGE_DRAINED' in r.stdout or 'ERROR SUMMARY: 0 errors' not in r.stdout+r.stderr:
        raise ValueError('Overflow memcheck failed')
    baseline=run('cuda',1)
    sites=ORDINAL.findall(baseline.stderr)
    if baseline.returncode or not sites or 'QSB_RANGE_DRAINED candidates=1' not in baseline.stdout:
        raise ValueError('CUDA baseline failed')
    for ordinal in range(1,len(sites)+1): check_failure(run('cuda',1,ordinal),ordinal)
    receipt={'scope':'diagnostic-only; synthetic CUDA failure after real call; forced nominations are not valid hits',
             'runs':records,'cudaSites':[{'ordinal':int(i),'site':s} for i,s in sites],
             'binaries':{n:hashlib.sha256((out/'bin'/n).read_bytes()).hexdigest() for n in ('normal','overflow','cuda')},
             'freshWithdrawal':False,'rangeCreditEligible':False}
    (out/'results.json').write_text(json.dumps(receipt,indent=2)+'\n')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['prepare','execute']);p.add_argument('--source',type=Path);p.add_argument('--params',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    if a.mode=='prepare':
        if a.source is None or a.params is None:p.error('prepare requires --source and --params')
        prepare(a.source,a.params,a.out)
    else:execute(a.out.resolve())
