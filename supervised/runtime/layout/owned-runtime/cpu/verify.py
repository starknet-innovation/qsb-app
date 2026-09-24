"""One local offline regtest CPU verification with durable Docker ownership.
Not an operational signing/export entry; caller owns supervisor lifetime.
"""
import base64,hashlib,json,time,os
from pathlib import Path
from ownership import Ledger,exclusive,enc
SOURCE=Path(__file__).with_name('registry.py')
HASH='34af03ec045c9a137f44b0c9725db8038667d6582ce7e6bb9f88abf9c3377af9'
def command(event):
 if not isinstance(event,dict) or set(event)!={'operation','payload','scopeBinding'} or event['operation'] not in ('pin-export-v4','pin-candidates-v5','pin-handoff-v5','subset-export-v5','subset-verify-v5'):raise ValueError('Public regtest envelope required')
 raw=enc(event)
 if len(raw)>1000000:raise ValueError('Oversized public envelope')
 source=SOURCE.read_bytes()
 if hashlib.sha256(source).hexdigest()!=HASH:raise ValueError('Verifier source changed')
 # Encode fixed source and public data, never interpolate executable user text.
 script="import base64,json,sys;ns={'__name__':'qsb_owned_reference'};exec(compile(base64.b64decode(%r),'<pinned-reference>','exec'),ns);raw=sys.stdin.buffer.read(1000001);assert len(raw)<=1000000;print(json.dumps({'ok':True,'result':ns['handle'](json.loads(raw))}))"%base64.b64encode(source).decode()
 return ['/usr/bin/python3','-c',script]
def register(event,directory,lifetime):
 argv=command(event);ledger=Ledger(directory)
 try:
  ledger.register(lifetime,argv,'sha256:2b6593d42253553344af6a3a451c121eb9ee94fed591dfc7fa0f15e616df2311' if event['operation']=='pin-export-v4' else 'sha256:06bd9bc5f97212a460aa7605367882ee434d219bd8d8680f90a70a4d2ad718f1')
  exclusive(ledger.root/'verification-binding.json',{'sourceSha256':HASH,'eventSha256':hashlib.sha256(enc(event)).hexdigest(),'argvSha256':hashlib.sha256(enc(argv)).hexdigest()})
 finally:ledger.close()
def execute(event,directory,hold=False):
 ledger=Ledger(directory)
 try:
  binding=ledger.read('verification-binding.json');argv=command(event)
  if binding!={'sourceSha256':HASH,'eventSha256':hashlib.sha256(enc(event)).hexdigest(),'argvSha256':hashlib.sha256(enc(argv)).hexdigest()} or ledger.read('registered.json')['command']!=argv:raise ValueError('Registered CPU binding changed')
  cid=ledger.create();ledger.start(enc(event).decode())
  exclusive(ledger.root/'client-started.json',{'pid':os.getpid(),'startTicks':Path('/proc/self/stat').read_text().split()[21]})
  while hold:time.sleep(1)
  code=ledger.docker('wait',cid);info=ledger.inspect(cid)
  if code!='0' or info['State']['Running'] or info['State']['ExitCode']!=0:raise ValueError('CPU verification failed')
  raw=ledger.docker('logs',cid)
  if len(raw.encode())>2000000:raise ValueError('Oversized verifier response')
  out=json.loads(raw)
  if out.get('ok') is not True or out['result'].get('format')!='qsb-owned-runtime-result-v1' or out['result'].get('inputHash')!=hashlib.sha256(enc(event)).hexdigest():raise ValueError('Invalid CPU response')
  exclusive(ledger.root/'cpu-result.json',out)
 finally:ledger.close()
