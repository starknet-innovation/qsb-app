import hashlib,json,os,pathlib,signal,subprocess,sys,fcntl,re
R=pathlib.Path(__file__).resolve().parent;cfg=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2])
if not re.fullmatch(r'/proc/self/fd/[0-9]+',str(cfg)):raise ValueError('Sealed config required')
configfd=int(str(cfg).rsplit('/',1)[1]);need=fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL
if fcntl.fcntl(configfd,fcntl.F_GET_SEALS)&need!=need:raise ValueError('Unsealed config')
p=subprocess.Popen([sys.executable,str(R/'owned_exec.py'),str(os.getpid()),'--','/usr/local/bin/node',str(R/'controller.cjs'),str(cfg),hashlib.sha256(cfg.read_bytes()).hexdigest(),str(out)],pass_fds=(3,configfd))
os.close(3)
s=pathlib.Path('/proc')/str(p.pid)/'stat';ident={'pid':p.pid,'ppid':os.getpid(),'pgid':os.getpgrp(),'startTicks':s.read_text().split()[21]}
with open(out/('identity-'+str(p.pid)+'.json'),'x') as f:f.write(json.dumps(ident));f.flush();os.fsync(f.fileno())
code=p.wait()
with open(out/'completion.pending','x') as f:f.write(json.dumps({'returncode':code,'childPid':p.pid}));f.flush();os.fsync(f.fileno())
(out/'completion.pending').replace(out/'completion.json');fd=os.open(out,os.O_RDONLY|os.O_DIRECTORY)
try:os.fsync(fd)
finally:os.close(fd)
while True:signal.pause()
