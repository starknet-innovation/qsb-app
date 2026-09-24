"""CPU-bind downloaded campaign records. Does not retry, submit or grant range credit."""
import argparse
import json
import math
from pathlib import Path
from package_pin_runtime import FROZEN_BINARY
from pin_campaign import digest, save
from pin_reference import verify, fingerprint


def check(plan, context, directory):
    if plan.get('format') != 'qsb-pin-campaign-v1' or plan.get('unfundedSynthetic') is not True or plan.get('binarySha256') != FROZEN_BINARY:
        raise ValueError('Frozen synthetic campaign required')
    requests=plan['requests'];directory=Path(directory)
    if json.loads((directory/'plan.json').read_text()) != plan:raise ValueError('Downloaded plan changed')
    results=[];uncertain=[]
    for i,request in enumerate(requests):
        intent=directory/f'{i:03d}.intent.json';result=directory/f'{i:03d}.result.json'
        if not intent.exists():
            if result.exists():raise ValueError('Result without intent')
            continue
        if intent.is_symlink() or result.is_symlink():raise ValueError('Symlink evidence rejected')
        expected={'planHash':digest(plan),'requestHash':digest(request),'attempt':i}
        if json.loads(intent.read_text())!=expected:raise ValueError('Intent binding mismatch')
        if not result.exists():uncertain.append(i);continue
        record=json.loads(result.read_text())
        if set(record)!={'requestHash','output','wallSeconds'} or record['requestHash']!=digest(request):raise ValueError('Result binding mismatch')
        seconds=record['wallSeconds']
        if type(seconds) not in (float,int) or not math.isfinite(seconds) or seconds<0:raise ValueError('Invalid timing')
        # Full transaction reconstruction and exact frozen output/range validation.
        verdict=verify(request,record['output'],context,FROZEN_BINARY)
        results.append({'attempt':i,'requestHash':digest(request),'outputHash':fingerprint(record['output']),
          'candidateCount':len(record['output']['candidates']),'reference':verdict,'wallSeconds':seconds})
    allowed={'plan.json','bounded-stop.json','stopped-for-verification.json'}
    allowed.update(f'{i:03d}.{suffix}.json' for i in range(len(requests)) for suffix in ('intent','result'))
    if any(p.name not in allowed for p in directory.iterdir()):raise ValueError('Unexpected campaign evidence')
    attempts=[r['attempt'] for r in results]
    if attempts!=list(range(len(results))):raise ValueError('Non-contiguous completed outputs')
    return {'scope':'CPU validation of downloaded compute-only campaign outputs; not withdrawal or coverage credit',
      'planHash':digest(plan),'contextHash':fingerprint(context),'results':results,'unresolvedAttempts':uncertain,
      'completedRangeOutputs':len(results),'validCandidateFound':any(r['reference']['decision']=='candidate-verified' for r in results),
      'rangeCreditGranted':False,'freshWithdrawal':False,'releaseStatus':'HOLD'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--plan',type=Path,required=True);p.add_argument('--context',type=Path,required=True);p.add_argument('--results',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();save(a.out,check(json.loads(a.plan.read_text()),json.loads(a.context.read_text()),a.results))
