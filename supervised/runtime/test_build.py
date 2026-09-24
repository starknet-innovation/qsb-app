"""Real source builds, deterministic archives, tamper rejection and installer interoperability."""
import hashlib,importlib.util,pathlib,subprocess,tempfile,json
root=pathlib.Path(__file__).resolve().parents[2];r=root/'supervised/runtime'
def run():return subprocess.run(['node',str(r/'build.mjs')],cwd=root,capture_output=True,text=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
a=run();assert a.returncode==0,a.stderr;first=sha(r/'runtime.tar.gz')
b=run();assert b.returncode==0,b.stderr;assert first==sha(r/'runtime.tar.gz')
spec=importlib.util.spec_from_file_location('installer',root/'supervised/install/install.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.verify(r/'dist',sha(r/'dist/manifest.json'),True)
# Alter a disposable copy, never the source checkout or a live installation.
import shutil
with tempfile.TemporaryDirectory() as t:
 copy=pathlib.Path(t)/'package';shutil.copytree(r/'dist',copy);(copy/'launch.py').write_text('tampered')
 try:m.verify(copy,sha(r/'dist/manifest.json'),True);raise AssertionError('tampering accepted')
 except ValueError:pass
print(json.dumps({'repeatBuildByteIdentical':True,'installerAccepted':True,'tamperRejected':True,'runtimeArchiveSha256':first,'historicalArchive':False}))
