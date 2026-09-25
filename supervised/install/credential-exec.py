"""Service-owned systemd credential -> single-use inherited FIFO. Never prints or persists the value."""
import os,re,stat,sys
from pathlib import Path

def main():
    if sys.platform!='linux' or os.geteuid()!=0:raise ValueError('Protected Linux service required')
    # systemd supplies this directory, not an HTTP/queue payload.
    directory=Path(os.environ['CREDENTIALS_DIRECTORY'])
    if not directory.is_absolute() or any(p.is_symlink() for p in [directory,*directory.parents]):raise ValueError('Credential directory differs')
    info=directory.stat()
    if info.st_uid!=0 or info.st_mode&0o022:raise ValueError('Credential directory is writable by another principal')
    fd=os.open(directory/'runpod_api',os.O_RDONLY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode&0o077 or s.st_size<1 or s.st_size>2048:raise ValueError('Invalid credential file')
        key=os.read(fd,2049)
        if not key or len(key)>2048 or b'\n' in key or b'\r' in key or b'\x00' in key:raise ValueError('Invalid credential shape')
    finally:os.close(fd)
    r,w=os.pipe2(os.O_CLOEXEC)
    # Write fits PIPE_BUF: no blocked writer retained and exactly one consumer owns this pipe.
    if os.write(w,key)!=len(key):raise ValueError('Credential transfer incomplete')
    os.close(w);key=b''
    if r!=3:os.dup2(r,3);os.close(r)
    os.set_inheritable(3,True)
    env={'PATH':'/usr/local/bin:/usr/bin:/bin','LANG':'C.UTF-8','AWS_REGION':'eu-west-1','QSB_NETWORK':'mainnet','PYTHONDONTWRITEBYTECODE':'1'}
    if len(sys.argv)==1:
        command=['node','/opt/qsb/dispatcher/dispatcher.cjs']
    elif len(sys.argv)==3 and sys.argv[1]=='watchdog' and re.fullmatch('[a-z0-9]{8,32}',sys.argv[2]):
        command=['node','/opt/qsb/dispatcher/watchdog-entry.mjs',sys.argv[2]]
    else:raise ValueError('Unknown service role')
    os.execve('/usr/local/bin/node',command,env)

if __name__=='__main__':
    try:main()
    except Exception:
        print('Private credential handoff unavailable',file=sys.stderr);sys.exit(2)
