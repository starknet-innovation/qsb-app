"""Fixed Linux process owner; no resource creation/deletion and no credential reads."""
import os,sys,json,ctypes,signal,subprocess,time,stat
from pathlib import Path
P=Path(__file__).resolve().parent
# Parent must remain alive. This process in turn owns launcher through parent-death exec.
def main():
 if sys.platform!='linux' or len(sys.argv)!=6:raise ValueError('Exact host invocation required')
 parent=int(sys.argv[1]);deadline=int(sys.argv[5]);now=int(time.time()*1000)
 if os.getppid()!=parent or parent<1 or deadline<=now or deadline>now+1800000:raise ValueError('Host lifetime differs')
 if ctypes.CDLL(None).prctl(1,signal.SIGKILL,0,0,0)!=0 or os.getppid()!=parent:raise ValueError('Parent ownership unavailable')
 if not stat.S_ISFIFO(os.fstat(3).st_mode):raise ValueError('Private pipe missing')
 command=['/usr/local/bin/python','/source/common-linux/owned_exec.py',str(os.getpid()),'--','/usr/local/bin/python','/source/launch.py','start',sys.argv[2],sys.argv[3],sys.argv[4],'/evidence/host-'+Path(sys.argv[3]).stem]
 child=subprocess.Popen(command,pass_fds=(3,),start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);os.close(3)
 identity={'pid':child.pid,'parentPid':os.getpid(),'pgid':child.pid,'startTicks':Path('/proc',str(child.pid),'stat').read_text().rsplit(')',1)[1].split()[19]};print(json.dumps({'kind':'identity',**identity}),flush=True)
 timed=False
 try:code=child.wait(timeout=max(.001,(deadline-int(time.time()*1000))/1000))
 except subprocess.TimeoutExpired:
  timed=True;os.killpg(child.pid,signal.SIGTERM)
  try:code=child.wait(timeout=30)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);code=child.wait(timeout=5)
 print(json.dumps({'kind':'terminal','identity':identity,'returncode':code,'deadlineReached':timed,'hostChildReaped':True,'providerCleanupVerified':False,'searchComplete':False}),flush=True)
if __name__=='__main__':
 try:main()
 except Exception:print('Fixed host operation unresolved',file=sys.stderr);sys.exit(2)
