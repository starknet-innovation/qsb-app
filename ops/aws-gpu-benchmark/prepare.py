"""Prepare a deterministic public-only, unfunded benchmark fixture."""
import base64, contextlib, hashlib, io, json, os, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'worker/cpu'))
from handler import PUBLIC_FIELDS, handler
import qsb_pipeline as pipeline

def prepare(destination):
    destination=Path(destination).resolve();destination.mkdir(parents=True,exist_ok=True)
    previous=os.getcwd()
    try:
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            os.chdir(tmp)
            pipeline.cmd_setup(SimpleNamespace(config='A',seed=20260925))
            state=json.loads(Path('qsb_state.json').read_text())
            public={k:state[k] for k in PUBLIC_FIELDS}
            public['round_sigs']=[{k:r[k] for k in ('r','s','sig')} for r in public['round_sigs']]
    finally:os.chdir(previous)
    event={'action':'export','publicStateJson':json.dumps(public,sort_keys=True),'stage':'round1',
           'sequence':2147483648,'locktime':500000000,
           'manifest':{'funding':{'txid':'11'*32,'vout':0,'value':'100000'},'helper':{'txid':'22'*32,'vout':1,'value':'10000'},'outputValue':'90000','fee':'20000','outputScript':'0014'+'33'*20}}
    (destination/'event.json').write_text(json.dumps(event,sort_keys=True)+'\n')
    hashes={}
    for stage in ('round1','round2'):
        result=handler({**event,'stage':stage});raw=base64.b64decode(result['parameterBase64'])
        name='digest_r'+stage[-1]+'.bin';(destination/name).write_bytes(raw)
        hashes[name]=hashlib.sha256(raw).hexdigest()
    (destination/'fixture.json').write_text(json.dumps({'seed':20260925,'synthetic':True,'funded':False,'files':hashes},indent=2)+'\n')
    return hashes
if __name__=='__main__':print(json.dumps(prepare(sys.argv[1])))
