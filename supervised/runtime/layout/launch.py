"""Fixed Linux entry: requires deployment-pinned manifest hash, private fd3 and external public config."""
from pathlib import Path
import hashlib,json,os,re,stat,subprocess,sys,fcntl
P=Path(__file__).resolve().parent
def fail():raise ValueError('Operational launch bindings missing or changed')
def run():
 if len(sys.argv)<3 or not re.fullmatch('[a-f0-9]{64}',sys.argv[2]):fail()
 if P!=Path('/source') or P.is_symlink() or sys.platform!='linux':fail()
 raw=(P/'manifest.json').read_bytes()
 if hashlib.sha256(raw).hexdigest()!=sys.argv[2]:fail()
 m=json.loads(raw)
 if m['format']!='qsb-operational-distribution-v1':fail()
 for n,v in m['files'].items():
  f=P/n
  if Path(n).is_absolute() or '..' in Path(n).parts or any(x.is_symlink() for x in [f,*f.parents]) or hashlib.sha256(f.read_bytes()).hexdigest()!=v['sha256']:fail()
 for n in ['handler.py','search_ranges.py']:
  alias=Path('/repo/outputs/qsb-vault/worker')/n
  if any(x.is_symlink() for x in [alias,*alias.parents]) or hashlib.sha256(alias.read_bytes()).hexdigest()!=m['files']['repo/outputs/qsb-vault/worker/'+n]['sha256']:fail()
 if sys.argv[1]=='check' and len(sys.argv)==3:
  print('Exact distribution verified; no execution authorized');return
 if sys.argv[1] not in ['start','retire'] or len(sys.argv)!=6:fail()
 if not stat.S_ISFIFO(os.fstat(3).st_mode):fail()
 cfg=Path(sys.argv[3]);out=Path(sys.argv[5])
 if not cfg.is_absolute() or cfg.is_symlink() or not cfg.is_file() or cfg.stat().st_size>1000000:fail()
 checked=cfg.read_bytes()
 if hashlib.sha256(checked).hexdigest()!=sys.argv[4]:fail()
 sealed=os.memfd_create('qsb-public-config',os.MFD_ALLOW_SEALING)
 written=0
 while written<len(checked):
  count=os.write(sealed,checked[written:])
  if count<=0:fail()
  written+=count
 os.lseek(sealed,0,os.SEEK_SET)
 fcntl.fcntl(sealed,fcntl.F_ADD_SEALS,fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL)
 os.set_inheritable(sealed,True);sealed_path='/proc/self/fd/'+str(sealed)
 if not re.fullmatch('/evidence/[a-z0-9-]+',str(out)) or Path('/evidence').resolve()!=Path('/evidence') or out.is_symlink():fail()
 if subprocess.run(['/usr/local/bin/node',str(P/'validate.cjs'),sealed_path,sys.argv[1]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,pass_fds=(sealed,)).returncode:fail()
 if sys.argv[1]=='start':
  if out.exists():fail()
  argv=['/usr/local/bin/python',str(P/'common-linux/supervisor.py'),sealed_path,str(out)]
 else:
  if not out.is_dir() or cfg!=out/'config.json':fail()
  table=json.loads(checked)['table'];argv=['/usr/local/bin/node',str(P/'common-linux/retire-entry.cjs'),str(out),table,sys.argv[4]]
 os.set_inheritable(3,True);os.execv(argv[0],argv)
if __name__=='__main__':
 try:run()
 except Exception:
  print('Operational launch rejected before dispatch',file=sys.stderr);sys.exit(2)
