"""Run inside disposable Linux container/host with public input artifacts, never real credentials."""
import hashlib,json,os,stat,subprocess,sys,tempfile,shutil
from pathlib import Path
sys.path.insert(0,'/input/dispatcher')
from install import install,verify

def h(p):return hashlib.sha256(p.read_bytes()).hexdigest()
runtime=Path('/input/runtime');dispatcher=Path('/input/dispatcher')
rh=h(runtime/'manifest.json');dh=h(dispatcher/'manifest.json');cases=[]
with tempfile.TemporaryDirectory() as t:
 root=Path(t);receipt=install(runtime,dispatcher,root,rh,dh)
 assert receipt['executionEnabled'] is False
 verify(root/'source',rh,True);verify(root/'opt/qsb/dispatcher',dh)
 assert (root/'source/launch.py').stat().st_mode&0o222==0
 cases.append('exact installation and protected modes')
 try:install(runtime,dispatcher,root,rh,dh);raise AssertionError()
 except ValueError:cases.append('existing installation refuses replacement')
with tempfile.TemporaryDirectory() as t:
 base=Path(t);bad=base/'bad';shutil.copytree(dispatcher,bad);(bad/'host.py').write_text('tamper')
 try:install(runtime,bad,base,rh,dh);raise AssertionError()
 except ValueError:assert not (base/'source').exists();cases.append('tampering rejected before publication')
with tempfile.TemporaryDirectory() as t:
 base=Path(t);bad=base/'bad';shutil.copytree(dispatcher,bad);(bad/'extra').write_text('unexpected')
 try:verify(bad,dh);raise AssertionError()
 except ValueError:cases.append('unlisted files rejected')
with tempfile.TemporaryDirectory() as t:
 base=Path(t);bad=base/'bad';shutil.copytree(dispatcher,bad);(bad/'host.py').unlink();(bad/'host.py').symlink_to(dispatcher/'host.py')
 try:verify(bad,dh);raise AssertionError()
 except ValueError:cases.append('symlink rejected')
# Fresh private credential directory; value is a public test marker, not provider authentication.
Path('/opt/qsb/dispatcher').mkdir(parents=True,exist_ok=True)
Path('/opt/qsb/dispatcher/dispatcher.cjs').write_text("const fs=require('fs');if(!fs.fstatSync(3).isFIFO()||fs.readFileSync(3,'utf8')!=='public-test-marker'||process.env.CREDENTIALS_DIRECTORY||process.env.LEAK_TEST)process.exit(2);console.log('private FIFO transfer passed');")
with tempfile.TemporaryDirectory() as t:
 d=Path(t);(d/'runpod_api').write_text('public-test-marker');(d/'runpod_api').chmod(0o400)
 env={**os.environ,'CREDENTIALS_DIRECTORY':t,'LEAK_TEST':'must-not-reach-child'}
 r=subprocess.run([sys.executable,'/input/dispatcher/credential-exec.py'],env=env,capture_output=True,timeout=10)
 assert r.returncode==0,(r.returncode,r.stderr.decode());assert b'public-test-marker' not in r.stdout+r.stderr;cases.append('real Linux private FIFO and environment isolation')
 (d/'runpod_api').chmod(0o644)
 r=subprocess.run([sys.executable,'/input/dispatcher/credential-exec.py'],env=env,capture_output=True,timeout=10)
 assert r.returncode==2;cases.append('insecure credential file rejected')
 (d/'runpod_api').unlink();(d/'runpod_api').symlink_to('/etc/passwd')
 r=subprocess.run([sys.executable,'/input/dispatcher/credential-exec.py'],env=env,capture_output=True,timeout=10)
 assert r.returncode==2;cases.append('credential symlink rejected')
print(json.dumps({'platform':sys.platform,'architecture':os.uname().machine,'checks':cases,'providerCalls':0,'realCredentials':False,'mainnetEnabled':False}))
