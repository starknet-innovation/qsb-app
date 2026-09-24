"""Fixed operational common-controller owner. No export authority."""
from adaptive import next_action
import ctypes,hashlib,json,os,selectors,signal,subprocess,sys,time,fcntl,re
from pathlib import Path
R=Path(__file__).resolve().parent
CPU=Path('/source/owned-runtime/cpu')
def h(b):return hashlib.sha256(b).hexdigest()
def enc(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def exclusive(p,v):
 with open(p,'xb') as f:f.write(enc(v));f.flush();os.fsync(f.fileno())
 fd=os.open(p.parent,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
def subreaper():
 if sys.platform!='linux' or ctypes.CDLL(None).prctl(36,1,0,0,0):raise RuntimeError('Linux subreaper required')
def reap():
 deadline=time.monotonic()+10;ids=[]
 while True:
  try:
   pid,status=os.waitpid(-1,os.WNOHANG)
   if pid:ids.append(pid);continue
  except ChildProcessError:return ids
  if time.monotonic()>deadline:raise RuntimeError('Owned descendants remain')
  time.sleep(.01)
def verify_entry(e,cfg):
 b=cfg['transport']['blueprint'];binding={'runPk':'SUPERVISION#'+b['runId'],'configHash':h(json.dumps(b,separators=(',',':'),ensure_ascii=False).encode())}
 if e.get('configHash')!=binding['configHash'] or e.get('runPk')!=binding['runPk']:raise ValueError('Common event binding differs')
 x=e['entry'];p=Path(x['directory'])
 if p.parent!=Path('/evidence/owned-cpu') or p.name!=x['operation'] or not p.name.startswith('runtime-cpu-') or p.is_symlink():raise ValueError('CPU directory differs')
 if x['ledger']!=str(p/'ledger') or x['scopeBinding'].get('runPk')!=binding['runPk'] or x['scopeBinding'].get('configHash')!=binding['configHash']:raise ValueError('CPU scope differs')
 if not x['scopeBinding'].get('operationKey','').startswith('OPERATION#'):raise ValueError('CPU operation differs')
 if x['sourceHash']!=h((CPU/'enrollment.json').read_bytes()) or x['callbackHash']!=h((CPU.parent/'runtime.cjs').read_bytes()) or x['supervisorHash']!=h((CPU/'supervisor.py').read_bytes()):raise ValueError('CPU source differs')
 return x

def recover_cpu(events,cfg):
 # Call only after this surviving same-namespace owner wait/reaped ALL its descendants.
 sys.path.insert(0,str(CPU));from ownership import Ledger
 out=[]
 for e in events:
  x=verify_entry(e,cfg);p=Path(x['directory']);conf=json.loads((p/'config.json').read_bytes())
  if h(enc(conf))!=x['configHash'] or h(enc(conf['event']))!=x['inputHash']:raise ValueError('Registered CPU input changed')
  for n in ('leader-identity.json','client-identity.json'):
   q=p/n
   if q.exists():
    identity=json.loads(q.read_bytes());stat=Path('/proc',str(identity['pid']),'stat')
    if stat.exists() and stat.read_text().split()[21]==identity['startTicks']:raise ValueError('Owned CPU process remains')
  census=p/'census.json'
  if not census.exists():
   # Before launcher registration no result is eligible. Unknown partial ledger needs separate investigation.
   if any((p/'ledger').glob('*')):raise ValueError('Partial CPU registration unresolved')
   out.append({'operation':x['operation'],'launched':False,'containerAbsent':True});continue
  c=json.loads(census.read_bytes())
  if c['configSha256']!=x['configHash'] or c['ledger']!=x['ledger']:raise ValueError('CPU census mismatch')
  enrollment=json.loads((CPU/'enrollment.json').read_bytes())['sources']
  if c['sources']!=enrollment:raise ValueError('CPU census source differs')
  ledger=Ledger(p/'ledger')
  try:
   if h(enc(ledger.read('registered.json')))!=c['registrationSha256']:raise ValueError('CPU registration mismatch')
   absent=ledger.reconcile()['containerAbsent']
  finally:ledger.close()
  if not absent:raise ValueError('CPU daemon remains')
  out.append({'operation':x['operation'],'containerAbsent':True,'clientReaped':True,'durableCensusCompleted':False})
 return out

def run(cfgfile,out):
 if not re.fullmatch(r"/proc/self/fd/[0-9]+",cfgfile):raise ValueError("Sealed public config required")
 configfd=int(cfgfile.rsplit("/",1)[1]);need=fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL
 if fcntl.fcntl(configfd,fcntl.F_GET_SEALS)&need!=need:raise ValueError("Public config is not sealed")
 subreaper();out=Path(out);out.mkdir(exist_ok=False);cfgbytes=Path(cfgfile).read_bytes();cfg=json.loads(cfgbytes)
 if cfg.get('format')!='qsb-common-operational-entry-v1':raise ValueError('Fixed public fixture required')
 enrollment=json.loads((R/'enrollment.json').read_bytes())
 for name,value in enrollment['cpu'].items():
  if h((CPU.parent/name).read_bytes())!=value:raise ValueError('CPU enrollment changed')
 for n,value in enrollment['files'].items():
  if h((R/n).read_bytes())!=value:raise ValueError('Source changed')
 with open(out/'config.json','xb') as f:f.write(cfgbytes);f.flush();os.fsync(f.fileno())
 exclusive(out/'started.json',{'configHash':h(cfgbytes),'sources':enrollment,'pid':os.getpid()})
 events=[];cpus=[];pending={};observed={};unknown=set();ready=False;stopped=False;done=False;shutdown=False;failure=None;child=None;buf=b'';opindex=0;processes_reaped=False;actions=0;last_result=None;next_status=None;stop_requested=False
 journal=open(out/'events.jsonl','xb',buffering=0)
 def record(kind,**data):
  e={'sequence':len(events),'monotonicNs':time.monotonic_ns(),'kind':kind,**data};events.append(e);journal.write(enc(e)+b'\n');os.fsync(journal.fileno())
 def finish():
  if unknown:raise ValueError('Unknown paid outcome blocks shutdown')
  if pending:
   rid=next(iter(pending))
   if rid in observed:raise ValueError('Observed unfinished outcome blocks no-send')
   send({'command':'reconcile_not_sent','pending':{k:v for k,v in pending[rid].items() if k!='outerConfigHash'}})
  else:send({'command':'shutdown'})
 def send(v):child.stdin.write(json.dumps(v,separators=(',',':'),ensure_ascii=False).encode()+b'\n');child.stdin.flush();record('command_sent',command=v)
 interrupted=[False]
 for s in (signal.SIGTERM,signal.SIGINT):signal.signal(s,lambda *_:interrupted.__setitem__(0,True))
 expected=h(json.dumps(cfg['transport']['blueprint'],separators=(',',':'),ensure_ascii=False).encode());runpk='SUPERVISION#'+cfg['transport']['blueprint']['runId']
 try:
  env={k:v for k,v in os.environ.items() if k in ('PATH','LD_LIBRARY_PATH','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_REGION','AWS_ENDPOINT_URL_DYNAMODB','AWS_EC2_METADATA_DISABLED','PYTHONDONTWRITEBYTECODE')}
  env['QSB_NETWORK']='mainnet'
  child=subprocess.Popen([sys.executable,str(R/'owned_exec.py'),str(os.getpid()),'--',sys.executable,str(R/'leader.py'),cfgfile,str(out)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(out/'child-stderr.log','wb'),start_new_session=True,env=env,pass_fds=(3,configfd))
  os.close(3)
  exclusive(out/'leader.json',{'pid':child.pid,'startTicks':Path('/proc',str(child.pid),'stat').read_text().split()[21]})
  sel=selectors.DefaultSelector();sel.register(child.stdout,selectors.EVENT_READ);driver=cfg.get('driver');remaining=max(0,(driver['deadlineMs']-int(time.time()*1000))/1000) if driver else 180;work_deadline=time.monotonic()+remaining;deadline=work_deadline+30
  while True:
   if (interrupted[0] or time.monotonic()>=work_deadline) and ready and not stopped and not stop_requested:send({'command':'stop_dispatch'});interrupted[0]=False;stop_requested=True;done=True;next_status=None
   if next_status is not None and time.monotonic()>=next_status and not stopped and not stop_requested:send({'command':'status'});next_status=None
   if time.monotonic()>deadline:raise TimeoutError('Common wrapper deadline')
   readable=sel.select(.02)
   # Completion is written after child exits; drain already-buffered final JSONL before accepting it.
   if not readable and (out/'completion.json').exists():break
   for key,_ in readable:
    data=os.read(key.fd,65536)
    if not data:raise ValueError('Unexpected stream EOF')
    buf+=data
    if len(buf)>2_000_000:raise ValueError('Oversized event')
    while b'\n' in buf:
     line,buf=buf.split(b'\n',1);e=json.loads(line);record('child_event',event=e,rawLineHex=line.hex());kind=e.get('event');rid=e.get('requestId')
     if e.get('outerConfigHash')!=h(cfgbytes) or e.get('configHash')!=expected:raise ValueError('Enrollment event differs')
     if kind.startswith('request_'):
      stage=e.get('stage');binding=cfg['transport']['blueprint']['pin' if stage=='pinning' else 'subset']
      if stage not in ('pinning','round1','round2') or any(e.get(n)!=binding[n] for n in ('parent','owner','revision')) or (stage!='pinning' and e.get('scope')!=binding['scope']):raise ValueError('Request stage scope differs')
      if rid in pending and any(e.get(n)!=pending[rid].get(n) for n in ('parent','scope','stage','owner','revision','intent')):raise ValueError('Request receipt identity differs')
     if kind=='cpu_registered':
      x=verify_entry(e,cfg)
      if any(z['entry']['operation']==x['operation'] for z in cpus):raise ValueError('Repeated CPU registration')
      cpus.append(e);send({'command':'cpu_registration_ack','operation':x['operation'],'registrationHash':h(line)})
     elif kind=='request_started':
      if stopped or rid in pending or rid in observed:raise ValueError('Invalid request start')
      pending[rid]=e
      # Operational stop is driven by supervisor signal or completion, not fixture flags.
     elif kind=='request_observed':
      if rid not in pending or rid in observed or not isinstance(e.get('providerId'),str):raise ValueError('Unbound provider observation')
      observed[rid]=e;send({'command':'observed_ack','requestId':rid,'providerId':e['providerId'],'observedHash':h(line)})
     elif kind in ('request_resolved','request_unknown'):
      if rid not in pending:raise ValueError('Missing started request')
      if kind=='request_resolved' and (rid not in observed or observed[rid]['providerId']!=e.get('providerId')):raise ValueError('Provider receipt missing')
      if kind=='request_unknown':unknown.add(rid)
      del pending[rid]
     elif kind in ('common_ready','operation_result'):
      ready=True
      if driver:
       if kind=='operation_result':
        if e.get('error'):done=True;stop_requested=True;send({'command':'stop_dispatch'});continue
        last_result=e.get('result')
       if stop_requested or stopped:
        done=True
        if stopped:finish()
       else:next_status=time.monotonic()+(driver['pollIntervalMs']/1000 if kind=='operation_result' else 0)
      elif opindex<len(cfg.get('operations',[])):
       send({'command':'operate',**cfg['operations'][opindex]});opindex+=1
      else:
       done=True
       if stopped:finish()
       else:send({'command':'stop_dispatch'})
     elif kind=='state_result':
      if not driver:raise ValueError('Unexpected driver status')
      state=e['state'];state['lastOperationResult']=last_result
      decision=next_action(state,int(time.time()*1000),driver,actions);record('driver_decision',decision=decision,actions=actions)
      if decision['action']=='stop':done=True;stop_requested=True;send({'command':'stop_dispatch'})
      elif decision['action']=='wait':next_status=time.monotonic()+driver['pollIntervalMs']/1000
      elif decision['action']=='command':
       command={k:v for k,v in decision.items() if k not in ('action',)}
       if command.get('command')=='operate':actions+=1
       send(command)
      else:raise ValueError('Unknown driver action')
     elif kind=='common_dispatch_stopped':
      stopped=True
      if done:finish()
     elif kind=='not_sent_reconciled':
      receipt=e.get('receipt',{});rid=e.get('requestId')
      if not stopped or rid not in pending or rid in observed or unknown or receipt.get('knownNoSend') is not True or receipt.get('writerHash')!=enrollment['files']['controller.cjs'] or receipt.get('pendingHash')!=h(json.dumps({k:v for k,v in pending[rid].items() if k!='outerConfigHash'},separators=(',',':'),ensure_ascii=False).encode()):raise ValueError('No-send receipt differs')
      del pending[rid];finish()
     elif kind=='shutdown_ready':
      if not stopped or pending or unknown or not isinstance(e.get('snapshotHash'),str):raise ValueError('Unresolved shutdown')
      shutdown=True
     elif kind=='protocol_failure':raise ValueError('Controller protocol failure: '+str(e.get('error')))
     else:raise ValueError('Unknown protocol event '+str(kind))
  if buf:raise ValueError('Truncated final event')
 except BaseException as exc:failure=type(exc).__name__+': '+str(exc);record('failure',error=failure)
 finally:
  if child:
   completion=json.loads((out/'completion.json').read_bytes()) if (out/'completion.json').exists() else {}
   try:os.killpg(child.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   try:
    child.wait(timeout=10)
    # PDEATHSIG cascades to CPU supervisors, their separate-session leaders, clients and CLI children.
    # waitpid(-1) includes adopted descendants across those sessions. No absence-only PID inference.
    reaped=reap();processes_reaped=True;record('processes_reaped',adopted=reaped)
    record('cpu_reconciliation',receipts=recover_cpu(cpus,cfg))
   except BaseException as exc:
    failure=failure or 'CPU cleanup: '+str(exc);record('cleanup_failure',error=str(exc),cpuRegistrations=cpus,authoritativeReapingRequired=True)
   if completion.get('returncode')!=0:failure=failure or 'Common child did not complete'
  journal.close()
 if not shutdown:failure=failure or 'Missing durable shutdown census'
 exclusive(out/('failure.json' if failure else 'receipt.json'),{'failure':failure,'shutdownReady':shutdown,'pending':list(pending),'unknown':list(unknown),'processesReaped':processes_reaped,'sealEligible':False,'providerDrainProven':False,'journalHash':h((out/'events.jsonl').read_bytes())})
 return 2 if failure else 0
if __name__=='__main__':sys.exit(run(sys.argv[1],sys.argv[2]))
