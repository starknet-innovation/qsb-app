"""Prepare trace-only copies of actual kernels. Production predicate stays intact."""
from pathlib import Path
import json, shutil, sys, contextlib, io, os
from types import SimpleNamespace
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'worker/cpu'))
import qsb_pipeline as pipeline

def fixtures(event_file, destination):
    event=json.loads(Path(event_file).read_text())
    state=json.loads(event['publicStateJson'])
    if 'hors_secrets' in state or any('k' in r for r in state['round_sigs']): raise ValueError('Only public state is allowed')
    destination=Path(destination).resolve();destination.mkdir(parents=True,exist_ok=True)
    previous=os.getcwd()
    try:
        for name,script in [('wpkh','0014'+'33'*20),('taproot','5120'+'44'*32)]:
            case=destination/name;case.mkdir(exist_ok=True);os.chdir(case)
            Path('qsb_state.json').write_text(event['publicStateJson'])
            m=event['manifest']
            args=SimpleNamespace(funding_txid=m['funding']['txid'],funding_vout=m['funding']['vout'],funding_value=int(m['funding']['value']),extra_input_txid=m['helper']['txid'],extra_input_vout=m['helper']['vout'],extra_input_value=int(m['helper']['value']),extra_input_sequence=0xfffffffe,version=1,sequence=0x80000000,locktime=500000000,output_value=int(m['outputValue']),output_address='00'*20)
            original=pipeline.p2pkh_script;pipeline.p2pkh_script=lambda _:bytes.fromhex(script)
            try:
                with contextlib.redirect_stdout(io.StringIO()): pipeline.cmd_export(args)
            finally: pipeline.p2pkh_script=original
    finally: os.chdir(previous)


def traced(destination):
    destination=Path(destination);shutil.copytree(ROOT/'worker/build',destination,dirs_exist_ok=True)
    pin=destination/'pinning/pinning.cu';s=pin.read_text()
    anchor='        int vv;\n        if (!FAST_TAIL && easy_mode)'
    trace='''        if(idx<8) printf("TRACE_PIN seq=%u lt=%u recid=%d hash=%08x%08x%08x%08x%08x%08x%08x%08x\\n",seq_value,lt,ri,hs[0],hs[1],hs[2],hs[3],hs[4],hs[5],hs[6],hs[7]);
'''
    assert s.count(anchor)==1;s=s.replace(anchor,trace+anchor)
    s=s.replace('uint32_t LT_MAX = 1744600000;', 'uint32_t LT_MAX = 500000257;')
    pin.write_text(s)
    subset=destination/'subset/tests/gpu_epochs/tree.cu';s=subset.read_text()
    anchor='        /* Ranked gate reads the state words.'
    trace='''        if(idx<8) printf("TRACE_SUB indices=%d,%d,%d,%d,%d,%d,%d,%d,%d recid=%d hash=%08x%08x%08x%08x%08x%08x%08x%08x\\n",skip[0],skip[1],skip[2],skip[3],skip[4],skip[5],skip[6],skip[7],skip[8],ri,hs[0],hs[1],hs[2],hs[3],hs[4],hs[5],hs[6],hs[7]);
'''
    assert s.count(anchor)==1;s=s.replace(anchor,trace+anchor);subset.write_text(s)

if __name__=='__main__':
    fixtures(sys.argv[1],sys.argv[2]);traced(sys.argv[3])
