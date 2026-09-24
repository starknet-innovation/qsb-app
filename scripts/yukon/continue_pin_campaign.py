"""Prepare only never-attempted work after a fully reconciled bounded campaign.
No resource allocation, automatic retry, coverage credit or GPU execution.
"""
import argparse
import json
from pathlib import Path
from pin_campaign import digest, save
from pin_runtime import validate
from verify_pin_campaign import check


def continuation(plan, context, previous, destination):
    previous=Path(previous);destination=Path(destination)
    receipt=check(plan,context,previous)
    count=receipt['completedRangeOutputs']
    if receipt['unresolvedAttempts'] or receipt['validCandidateFound'] or not 0<count<len(plan['requests']):
        raise ValueError('No fully reconciled unattempted continuation')
    stop=json.loads((previous/'bounded-stop.json').read_text())
    if stop!={'completedRangeOutputs':count,'rangeCreditGranted':False,'cpuVerified':False,'releaseStatus':'HOLD'} or (previous/'stopped-for-verification.json').exists():
        raise ValueError('Original campaign did not stop cleanly at budget')
    # Validate the whole original sequence, including the completed/tail boundary.
    before=None
    for request in plan['requests']:
        validate(request,plan['binarySha256'])
        r=request['range']
        if r['locktime']+r['locktimeCount']-1>1744600000:raise ValueError('Unsupported verifier domain')
        if before:
            p=before['range']
            if r['sequence']!=p['sequence']+p['sequenceCount'] or any(r[k]!=p[k] for k in ('locktime','locktimeCount')):
                raise ValueError('Overlapping or discontinuous plan')
            if any(request[k]!=before[k] for k in ('manifestHash','parameterBase64','parameterSha256')):
                raise ValueError('Mixed context plan')
        before=request
    next_plan={**plan,'requests':plan['requests'][count:]}
    lineage={'format':'qsb-pin-campaign-continuation-v1','parentPlanHash':digest(plan),'parentReceiptHash':digest(receipt),
      'nextPlanHash':digest(next_plan),'completedParentOutputs':count,'remainingRequests':len(next_plan['requests']),
      'firstUnattemptedRequestHash':digest(next_plan['requests'][0]),'contextHash':receipt['contextHash'],
      'gpuExecuted':False,'dispatchAuthorized':False,'releaseStatus':'HOLD'}
    destination.mkdir(parents=True,exist_ok=False)
    save(destination/'plan.json',next_plan);save(destination/'context.json',context);save(destination/'lineage.json',lineage)
    return lineage

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--plan',type=Path,required=True);p.add_argument('--context',type=Path,required=True);p.add_argument('--previous',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();continuation(json.loads(a.plan.read_text()),json.loads(a.context.read_text()),a.previous,a.out)
