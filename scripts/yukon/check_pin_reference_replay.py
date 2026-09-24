"""CPU-only public known-solution replay; never invokes a solver or spends a fixture."""
import argparse
import hashlib
import json
from pathlib import Path
from pin_reference import fingerprint,reference,verify
from pin_runtime import PROTOCOL


def check(bundle):
    context={'publicStateJson':bundle['request']['vault']['publicStateJson'],
             'manifest':bundle['fixture']['manifest']}
    # Identity here deliberately does not attest to a GPU build or GPU output.
    sentinel=hashlib.sha256(b'CPU-only historical replay; no GPU execution').hexdigest()
    solution=bundle['solution'];sequence=solution['sequence'];locktime=solution['locktime']
    lower=locktime//256*256
    request={'protocol':PROTOCOL,'requestId':'cpu-only-historical-pin-replay',
      'manifestHash':fingerprint(context['manifest']),'binarySha256':sentinel,
      **reference({**context,'stage':'pinning','action':'export'}),
      'range':{'sequence':sequence,'sequenceCount':1,'locktime':lower,'locktimeCount':locktime-lower+1}}
    output={k:request[k] for k in ('protocol','requestId','manifestHash','binarySha256','parameterSha256','range')}
    output.update(status='range-drained',candidates=[{'sequence':sequence,'locktime':locktime,'recid':0}],
      verified=False,rangeCreditEligible=False,releaseStatus='HOLD')
    verdict=verify(request,output,context,sentinel)
    if verdict['decision']!='candidate-verified':raise ValueError('Historical candidate not reproduced')
    # Cross-context substitution must reject even when envelopes are updated together.
    altered=json.loads(json.dumps(context));altered['manifest']['outputValue']=str(int(altered['manifest']['outputValue'])-1)
    altered['manifest']['fee']=str(int(altered['manifest']['fee'])+1)
    changed_request={**request,'manifestHash':fingerprint(altered['manifest'])}
    changed_output={**output,'manifestHash':changed_request['manifestHash']}
    try:verify(changed_request,changed_output,altered,sentinel)
    except ValueError:pass
    else:raise ValueError('Cross-context substitution accepted')
    return {'scope':'CPU-only historical public solution replay; synthetic runtime envelope',
      'contextHash':fingerprint(context),'parameterSha256':request['parameterSha256'],
      'verdict':verdict,'crossContextRejected':True,'gpuExecuted':False,'rangeSearched':False,
      'fixtureSpentThisRun':False,'freshWithdrawal':False,'releaseStatus':'HOLD'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--public-bundle',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    receipt=check(json.loads(a.public_bundle.read_text()))
    with a.out.open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
