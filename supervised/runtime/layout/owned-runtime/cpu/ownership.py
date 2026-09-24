"""Isolated supervisor-owned Docker lifetime ledger; no automatic create retries.
Caller must keep its supervisor lock for every operation and reap all clients
before final cleanup. An unobserved create remains uncertain even when absent.
"""
import fcntl, hashlib, json, os, re, subprocess, uuid, sys
from pathlib import Path
IMAGE='sha256:06bd9bc5f97212a460aa7605367882ee434d219bd8d8680f90a70a4d2ad718f1'
LABEL='qsb.supervised.cpu.operation'
CLEAN_ENV={k:v for k,v in os.environ.items() if not k.startswith('DOCKER_')}

def enc(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def syncdir(p):
 fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
def exclusive(path,value):
 with open(path,'xb') as f:f.write(enc(value));f.flush();os.fsync(f.fileno())
 syncdir(path.parent)
class Ledger:
 def __init__(self,root):
  self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True);syncdir(self.root.parent)
  self.lock=open(self.root/'owner.lock','a+b');fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 def close(self):self.lock.close()
 def read(self,name):
  if self.lock.closed:raise ValueError("Ledger is closed")
  return json.loads((self.root/name).read_bytes())
 def register(self,lifetime,command,image):
  if self.lock.closed:raise ValueError("Ledger is closed")
  if not re.fullmatch(r'[a-zA-Z0-9_-]{1,120}',lifetime):raise ValueError('Invalid lifetime')
  if not isinstance(command,list) or not command or any(not isinstance(x,str) or '\0' in x for x in command):raise ValueError('Invalid command')
  context=self.raw('context','show')
  endpoint=json.loads(self.raw('context','inspect',context))[0]['Endpoints']['docker']['Host']
  engine=self.raw('--context',context,'info','--format','{{.ID}}')
  if not engine:raise ValueError('Missing Docker engine identity')
  if image not in (IMAGE,'sha256:2b6593d42253553344af6a3a451c121eb9ee94fed591dfc7fa0f15e616df2311'):raise ValueError('Unenrolled immutable image')
  op=str(uuid.uuid4());record={'format':'qsb-owned-cpu-v1','operation':op,'lifetime':lifetime,'name':'qsb-owned-cpu-'+op,'image':image,'command':command,'engine':{'context':context,'endpoint':endpoint,'id':engine}}
  exclusive(self.root/'registered.json',record);return record
 def raw(self,*args,input_text=None):
  r=subprocess.run([sys.executable,str(Path(__file__).with_name('owned_exec.py')),str(os.getpid()),'--','/usr/local/bin/docker',*args],env=CLEAN_ENV,input=input_text,capture_output=True,text=True,timeout=120 if len(args)>2 and args[0]=='--context' and args[2] in ('wait','start') else 30)
  if r.returncode:raise RuntimeError('Docker operation failed: '+args[0])
  return r.stdout.strip()
 def docker(self,*args,input_text=None):
  e=self.read('registered.json')['engine']
  endpoint=json.loads(self.raw('context','inspect',e['context']))[0]['Endpoints']['docker']['Host']
  if endpoint!=e['endpoint'] or self.raw('--context',e['context'],'info','--format','{{.ID}}')!=e['id']:raise ValueError('Docker engine binding changed')
  return self.raw('--context',e['context'],*args,input_text=input_text)
 def create(self):
  r=self.read('registered.json')
  if (self.root/'cleaned.json').exists() or (self.root/'cleanup-started.json').exists():raise ValueError('Lifetime already cleaned')
  # Create-only marker precedes daemon mutation; any repeated create rejects.
  exclusive(self.root/'create-started.json',{'registeredHash':hashlib.sha256(enc(r)).hexdigest()})
  cid=self.docker('create','-i','--pull','never','--name',r['name'],'--label',LABEL+'='+r['operation'],'--network','none','--read-only','--platform','linux/amd64','--tmpfs','/tmp:rw,nosuid,size=128m','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint',r['command'][0],r['image'],*r['command'][1:])
  if not re.fullmatch('[0-9a-f]{64}',cid):raise ValueError('Malformed container ID')
  exclusive(self.root/'created.json',{'id':cid});return cid
 def inspect(self,cid):
  rows=json.loads(self.docker('inspect',cid));r=self.read('registered.json')
  if len(rows)!=1:raise ValueError('Unexpected inspect count')
  v=rows[0]
  if v['Id']!=cid or v['Name']!='/'+r['name'] or v['Image']!=r['image'] or v['Config'].get('Labels',{}).get(LABEL)!=r['operation']:raise ValueError('Container ownership mismatch')
  if v['Config'].get('OpenStdin') is not True:raise ValueError('Container stdin binding changed')
  if v['Config']['Entrypoint']!=[r['command'][0]] or (v['Config']['Cmd'] or [])!=r['command'][1:] or v['HostConfig']['NetworkMode']!='none' or not v['HostConfig']['ReadonlyRootfs'] or v.get('Mounts'):raise ValueError('Container execution binding changed')
  if v['HostConfig'].get('Tmpfs')!={'/tmp':'rw,nosuid,size=128m'} or v['HostConfig'].get('CapDrop')!=['ALL'] or v['HostConfig'].get('SecurityOpt')!=['no-new-privileges']:raise ValueError('Container isolation mismatch')
  return v
 def start(self,input_text):
  if (self.root/'cleanup-started.json').exists():raise ValueError('Cleanup already started')
  cid=self.read('created.json')['id'];self.inspect(cid)
  exclusive(self.root/'start-requested.json',{'id':cid});self.docker('start','-ai',cid,input_text=input_text);return cid
 def reconcile(self):
  r=self.read('registered.json')
  # Successful full list distinguishes absence from RPC/permission failure.
  ids=self.docker('ps','-aq','--no-trunc','--filter','name=^/'+r['name']+'$').splitlines()
  if len(ids)>1:raise ValueError('Ambiguous container name')
  known=self.read('created.json')['id'] if (self.root/'created.json').exists() else None
  if known:
   by_id=self.docker('ps','-aq','--no-trunc','--filter','id='+known).splitlines()
   if by_id and by_id!=[known]:raise ValueError('Ambiguous full ID query')
   if by_id:
    self.inspect(known) # Reject name drift; never confuse it with absence.
    if ids!=[known]:raise ValueError('Name and ID census disagree')
   elif ids:raise ValueError('Registered name now refers to another container')
  if (self.root/'cleaned.json').exists():
   if ids or (known and by_id):raise ValueError('Container appeared after cleanup')
   return self.read('cleaned.json')
  if ids:
   cid=ids[0]
   if known and known!=cid:raise ValueError('Container identity changed')
   self.inspect(cid)
   if not known:exclusive(self.root/'created.json',{'id':cid,'recoveredFromDaemon':True})
   if not (self.root/'cleanup-started.json').exists():exclusive(self.root/'cleanup-started.json',{'id':cid})
   self.docker('rm','-f',cid)
   if self.docker('ps','-aq','--no-trunc','--filter','id='+cid):raise ValueError('Owned container remains')
  elif not known and (self.root/'create-started.json').exists():
   raise ValueError('Unobserved create is uncertain; absence grants no cleanup credit')
  # Requires caller quiescence; no executable can create/start again after cleanup.
  result={'containerAbsent':True,'knownId':known or (ids[0] if ids else None),'providerTerminalProven':False,'sealEligible':False}
  exclusive(self.root/'cleaned.json',result);return result
