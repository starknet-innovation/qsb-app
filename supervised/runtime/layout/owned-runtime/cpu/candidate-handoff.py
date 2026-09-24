"""Fixed complete pin candidate scan using the frozen reviewed v5 public reference."""
import json,hashlib,re
BASE_SOURCE='"""One request, public CPU verification only; no compute, signature or dispatch."""\nimport sys,json,hashlib,contextlib,io\nfrom pathlib import Path\nROOT=Path(\'/opt/qsb-validation\')\nEXPECTED=\'14ca2c729ecee121c715b7ff1acb9b8656b8650f8f4c02e3454c1067d22edeb9\'\ndef digest(b):return hashlib.sha256(b).hexdigest()\ndef canonical(x):return json.dumps(x,sort_keys=True,separators=(\',\',\':\'),ensure_ascii=True).encode()\ndef handle(e):\n if set(e)!={\'publicStateJson\',\'manifest\',\'network\',\'candidate\'} or e[\'network\'] not in (\'regtest\',\'testnet4\',\'mainnet\'):raise ValueError(\'Invalid public envelope\')\n c=e[\'candidate\']\n if set(c)!={\'sequence\',\'locktime\'} or any(type(c[k]) is not int for k in c) or not 0x80000000<=c[\'sequence\']<=0xffffffff or not 500000000<=c[\'locktime\']<=1744600000:raise ValueError(\'Invalid pin candidate\')\n raw=(ROOT/\'runtime-binding.json\').read_bytes()\n if digest(raw)!=EXPECTED:raise ValueError(\'Runtime identity mismatch\')\n binding=json.loads(raw)\n for name,want in binding[\'files\'].items():\n  if \'..\' in Path(name).parts or Path(name).is_absolute() or (ROOT/name).is_symlink() or digest((ROOT/name).read_bytes())!=want:raise ValueError(\'Artifact mismatch\')\n sys.path.insert(0,str(ROOT/\'reference\'))\n import handler\n context={\'publicStateJson\':e[\'publicStateJson\'],\'manifest\':e[\'manifest\'],**c}\n with contextlib.redirect_stdout(io.StringIO()):\n  verdict=handler.handler(dict(context,action=\'verify\',stage=\'pinning\',candidates=[f"sequence={c[\'sequence\']}\\nlocktime={c[\'locktime\']}\\n"]))\n  if verdict!={\'valid\':True,**c}:raise ValueError(\'Pin not CPU verified\')\n  stages={s:handler.handler(dict(context,action=\'export\',stage=s)) for s in (\'round1\',\'round2\')}\n return {\'format\':\'qsb-isolated-pin-handoff-v1\',\'runtimeHash\':EXPECTED,\'publicContextHash\':digest(canonical({\'publicStateJson\':e[\'publicStateJson\'],\'manifest\':e[\'manifest\'],\'network\':e[\'network\']})),\'pin\':c,\'referenceChecked\':True,\'parameters\':stages,\'dispatchAuthorized\':False,\'consensusVerified\':False}\nif __name__==\'__main__\':\n try:\n  raw=sys.stdin.buffer.read(200001)\n  if len(raw)>200000:raise ValueError(\'Oversized request\')\n  print(json.dumps(handle(json.loads(raw)),separators=(\',\',\':\')))\n except Exception as e:\n  print(json.dumps({\'error\':str(e)}));sys.exit(2)\n'
ns={'__name__':'owned_pin_reference'}
exec(compile(BASE_SOURCE,'<pinned-handoff>','exec'),ns)
def handle(e):
 if set(e)!={'publicStateJson','manifest','network','candidates','candidateFiles'} or e['network']!='regtest' or not isinstance(e['candidates'],list) or not e['candidates']:raise ValueError('Invalid candidate envelope')
 if not isinstance(e['candidateFiles'],list) or not 1<=len(e['candidateFiles'])<=32 or any(not isinstance(f,str) or len(f.encode())>=16384 for f in e['candidateFiles']):raise ValueError('Invalid file groups')
 parsed=[]
 for file in e['candidateFiles']:
  records=[r for r in re.split(r'(?=^sequence=)',file,flags=re.M) if r.strip()]
  if not records:raise ValueError('Empty group')
  for record in records:
   seq=re.findall(r'^sequence=(\d+)\r?$',record,flags=re.M);lt=re.findall(r'^locktime=(\d+)\r?$',record,flags=re.M)
   if len(seq)!=1 or len(lt)!=1:raise ValueError('Ambiguous record')
   parsed.append({'sequence':int(seq[0]),'locktime':int(lt[0])})
 if parsed!=e['candidates']:raise ValueError('Candidate groups differ')
 context={k:e[k] for k in ('publicStateJson','manifest','network')}
 context_hash=hashlib.sha256(json.dumps(context,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()
 for c in e['candidates']:
  if set(c)!={'sequence','locktime'} or any(type(c[k]) is not int for k in c) or not 0x80000000<=c['sequence']<=0xffffffff or not 500000000<=c['locktime']<=1744600000:raise ValueError('Malformed parsed pin')
 raw=(ns['ROOT']/'runtime-binding.json').read_bytes()
 if ns['digest'](raw)!=ns['EXPECTED']:raise ValueError('Runtime identity mismatch')
 binding=json.loads(raw)
 for name,want in binding['files'].items():
  path=ns['Path'](name)
  if '..' in path.parts or path.is_absolute() or (ns['ROOT']/name).is_symlink() or ns['digest']((ns['ROOT']/name).read_bytes())!=want:raise ValueError('Artifact mismatch')
 ns['sys'].path.insert(0,str(ns['ROOT']/'reference'))
 import handler
 with ns['contextlib'].redirect_stdout(ns['io'].StringIO()):
  verdict=handler.handler({'publicStateJson':e['publicStateJson'],'manifest':e['manifest'],'action':'verify','stage':'pinning','candidates':e['candidateFiles']})
 candidate_hash=hashlib.sha256(json.dumps(e['candidates'],sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()
 out={'format':'qsb-owned-pin-verdict-v1','runtimeHash':ns['EXPECTED'],'publicContextHash':context_hash,'candidateFilesHash':hashlib.sha256(json.dumps(e['candidateFiles'],sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest(),'candidatesHash':candidate_hash,'referenceChecked':True,'verdict':verdict}
 if verdict in ({'valid':False},{'valid':False,'derOnly':True}):return out
 c={k:verdict[k] for k in ('sequence','locktime')}
 if verdict!={'valid':True,**c} or c not in e['candidates']:raise ValueError('Unbound pin verdict')
 out['handoff']=ns['handle']({**context,'candidate':c})
 return out
