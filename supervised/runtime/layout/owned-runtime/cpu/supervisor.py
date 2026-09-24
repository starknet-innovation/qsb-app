import ctypes,hashlib,json,os,signal,subprocess,sys,time
from pathlib import Path
from ownership import Ledger,exclusive,enc
from verify import register,command
S=Path(__file__).resolve().parent
SOURCES=['supervisor.py','leader.py','client.py','owned_exec.py','ownership.py','verify.py','handoff.py','candidate-handoff.py','registry.py','publicstate.py']
def hashes():return {n:hashlib.sha256((S/n).read_bytes()).hexdigest() for n in SOURCES}
def reap():
 end=time.monotonic()+5
 while True:
  try:
   pid,_=os.waitpid(-1,os.WNOHANG)
   if not pid:
    if time.monotonic()>end:raise TimeoutError("Owned descendants remain")
    time.sleep(.01)
  except ChildProcessError:break
def alive(i):
 p=Path('/proc',str(i['pid']),'stat')
 return p.exists() and p.read_text().split()[21]==i['startTicks']
def recover(root,client_reaped):
 if not client_reaped:raise ValueError('Authoritative owned process reaping required')
 census=json.loads((root/'census.json').read_bytes())
 if census['sources']!=hashes() or census['ledger']!=str(root/'ledger'):raise ValueError('Recovery census differs')
 # This path is only called by the surviving same-namespace test owner after wait/reap.
 for n in ['leader-identity.json','client-identity.json']:
  p=root/n
  if p.exists() and alive(json.loads(p.read_bytes())):raise ValueError('Owned client remains')
 ledger=Ledger(root/'ledger')
 try:
  if hashlib.sha256(enc(ledger.read('registered.json'))).hexdigest()!=census['registrationSha256']:raise ValueError('Registration differs')
  result=ledger.reconcile()
 finally:ledger.close()
 exclusive(root/'cleanup-receipt.json',{'sameNamespaceReaped':True,'containerAbsent':result['containerAbsent'],'sealEligible':False})
def main():
 root=Path(sys.argv[1]);config=json.loads((root/'config.json').read_bytes())
 if config['format']!='qsb-owned-pin-supervisor-test-v1' or type(config['holdAfterStart']) is not bool:raise ValueError('Fixed diagnostic configuration required')
 if hashes()!=json.loads((S/'enrollment.json').read_bytes())['sources']:raise ValueError('Fixed source enrollment changed')
 assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
 register(config['event'],root/'ledger',config['lifetime'])
 registration=json.loads((root/'ledger/registered.json').read_bytes())
 exclusive(root/'census.json',{'sources':hashes(),'configSha256':hashlib.sha256(enc(config)).hexdigest(),'ledger':str(root/'ledger'),'registrationSha256':hashlib.sha256(enc(registration)).hexdigest(),'commandSha256':hashlib.sha256(enc(command(config['event']))).hexdigest(),'sealEligible':False})
 child=subprocess.Popen([sys.executable,str(S/'owned_exec.py'),str(os.getpid()),'--',sys.executable,str(S/'leader.py'),str(root)],start_new_session=True)
 exclusive(root/'leader-identity.json',{'pid':child.pid,'startTicks':Path('/proc',str(child.pid),'stat').read_text().split()[21]})
 code=None
 try:
  start=time.monotonic()
  while not (root/'completion.json').exists():
   if time.monotonic()-start>120:raise TimeoutError('CPU child deadline')
   if child.poll() is not None:raise ValueError('Leader unexpectedly exited')
   time.sleep(.02)
  code=json.loads((root/'completion.json').read_bytes())['returncode']
 finally:
  if child.poll() is None:os.killpg(child.pid,signal.SIGKILL)
  child.wait();reap();recover(root,True)
 if code!=0:raise ValueError('CPU client failed')
 result=json.loads((root/'ledger/cpu-result.json').read_bytes())
 exclusive(root/'verified-result.json',{'result':result['result'],'configSha256':hashlib.sha256(enc(config)).hexdigest(),'cleanupSha256':hashlib.sha256((root/'cleanup-receipt.json').read_bytes()).hexdigest(),'sealEligible':False,'historicalCPUReplayOnly':True})
if __name__=='__main__':main()
