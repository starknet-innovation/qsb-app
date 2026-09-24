"""Create public synthetic, unfunded search inputs; never reads a wallet or old fixture."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import secrets
from package_pin_runtime import FROZEN_BINARY
from pin_reference import fingerprint, reference, prepare
from pin_campaign import save
from test_pin_reference import ReferenceBinding


def build(directory):
    directory=Path(directory)
    if directory.exists():raise ValueError('Fresh output directory required')
    ReferenceBinding.setUpClass()
    context=copy.deepcopy(ReferenceBinding.ctx)
    nonce=secrets.token_hex(32)
    # Nonexistent outpoints, domain-separated from each other and earlier test contexts.
    for role in ('funding','helper'):
        context['manifest'][role]['txid']=hashlib.sha256(('qsb-unfunded-pin-'+role+nonce).encode()).hexdigest()
    exported=reference({**context,'stage':'pinning','action':'export'})
    requests=[]
    for i in range(100):
        requests.append({'protocol':'qsb-yukon-pinning-research-v1','requestId':f'unfunded-{nonce[:24]}-{i}',
          'manifestHash':fingerprint(context['manifest']),'binarySha256':FROZEN_BINARY,**exported,
          'range':{'sequence':2**31+16*i,'sequenceCount':16,'locktime':500000000,'locktimeCount':1244600001}})
    for request in (requests[0],requests[-1]):prepare(request,context,FROZEN_BINARY)
    plan={'format':'qsb-pin-campaign-v1','binarySha256':FROZEN_BINARY,'requests':requests,'unfundedSynthetic':True}
    directory.mkdir(parents=True,exist_ok=False)
    save(directory/'context.json',context);save(directory/'plan.json',plan)
    save(directory/'preparation.json',{'format':'qsb-unfunded-campaign-preparation-v1','contextHash':fingerprint(context),'planHash':fingerprint(plan),'requests':100,'maxRuntimeSeconds':1200,'gpuExecuted':False,'releaseStatus':'HOLD'})

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);a=p.parse_args();build(a.out)
