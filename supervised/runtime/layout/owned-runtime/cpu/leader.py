import os,subprocess,sys,signal
from pathlib import Path
from ownership import exclusive
r=Path(sys.argv[1]);p=subprocess.Popen([sys.executable,str(Path(__file__).with_name('owned_exec.py')),str(os.getpid()),'--',sys.executable,str(Path(__file__).with_name('client.py')),str(r)])
exclusive(r/'client-identity.json',{'pid':p.pid,'startTicks':Path('/proc',str(p.pid),'stat').read_text().split()[21]})
code=p.wait();exclusive(r/'completion.json',{'returncode':code})
while True:signal.pause()
