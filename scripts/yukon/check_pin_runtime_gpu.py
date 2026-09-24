"""Execute reviewed public runtime requests on one local CUDA GPU; no provider API."""
import argparse
import json
from pathlib import Path
import time
from pin_runtime import run

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--requests',type=Path,required=True);p.add_argument('--binary',type=Path,required=True);p.add_argument('--sha256',required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    if a.out.exists():raise ValueError('Do not overwrite results')
    records=[]
    for request in json.loads(a.requests.read_text()):
        start=time.monotonic();output=run(request,a.binary,a.sha256,timeout=120)
        records.append({'output':output,'wallSeconds':time.monotonic()-start})
        a.out.with_suffix('.partial.json').write_text(json.dumps({'complete':False,'runs':records},indent=2)+'\n')
        if output['status']!='range-drained':raise ValueError('Native runtime failed; partial receipt preserved')
    a.out.write_text(json.dumps({'scope':'synthetic unfunded runtime ranges, not fresh withdrawal','runs':records,'binarySha256':a.sha256,'releaseStatus':'HOLD'},indent=2)+'\n')
