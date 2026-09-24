"""One request, public CPU verification only; no compute, signature or dispatch."""
import sys,json,hashlib,contextlib,io
from pathlib import Path
ROOT=Path('/opt/qsb-validation')
EXPECTED='14ca2c729ecee121c715b7ff1acb9b8656b8650f8f4c02e3454c1067d22edeb9'
def digest(b):return hashlib.sha256(b).hexdigest()
def canonical(x):return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
def handle(e):
 if set(e)!={'publicStateJson','manifest','network','candidate'} or e['network'] not in ('regtest','testnet4','mainnet'):raise ValueError('Invalid public envelope')
 c=e['candidate']
 if set(c)!={'sequence','locktime'} or any(type(c[k]) is not int for k in c) or not 0x80000000<=c['sequence']<=0xffffffff or not 500000000<=c['locktime']<=1744600000:raise ValueError('Invalid pin candidate')
 raw=(ROOT/'runtime-binding.json').read_bytes()
 if digest(raw)!=EXPECTED:raise ValueError('Runtime identity mismatch')
 binding=json.loads(raw)
 for name,want in binding['files'].items():
  if '..' in Path(name).parts or Path(name).is_absolute() or (ROOT/name).is_symlink() or digest((ROOT/name).read_bytes())!=want:raise ValueError('Artifact mismatch')
 sys.path.insert(0,str(ROOT/'reference'))
 import handler
 context={'publicStateJson':e['publicStateJson'],'manifest':e['manifest'],**c}
 with contextlib.redirect_stdout(io.StringIO()):
  verdict=handler.handler(dict(context,action='verify',stage='pinning',candidates=[f"sequence={c['sequence']}\nlocktime={c['locktime']}\n"]))
  if verdict!={'valid':True,**c}:raise ValueError('Pin not CPU verified')
  stages={s:handler.handler(dict(context,action='export',stage=s)) for s in ('round1','round2')}
 return {'format':'qsb-isolated-pin-handoff-v1','runtimeHash':EXPECTED,'publicContextHash':digest(canonical({'publicStateJson':e['publicStateJson'],'manifest':e['manifest'],'network':e['network']})),'pin':c,'referenceChecked':True,'parameters':stages,'dispatchAuthorized':False,'consensusVerified':False}
if __name__=='__main__':
 try:
  raw=sys.stdin.buffer.read(200001)
  if len(raw)>200000:raise ValueError('Oversized request')
  print(json.dumps(handle(json.loads(raw)),separators=(',',':')))
 except Exception as e:
  print(json.dumps({'error':str(e)}));sys.exit(2)
