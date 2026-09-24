"""Linux exec launcher: kill the owned child if its launching parent dies.

Run in a fresh Python process, never preexec_fn in a threaded queue worker.
The parent PID is captured before spawn and checked after prctl to close the
parent-exit-before-registration race. Failure never executes the command.
"""
import ctypes, os, signal, sys

def main():
    if sys.platform != 'linux' or len(sys.argv) < 4 or sys.argv[2] != '--':
        raise SystemExit('Owned execution requires Linux and explicit parent PID')
    parent = int(sys.argv[1])
    if parent < 1 or os.getppid() != parent:
        raise SystemExit('Launching parent is absent')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'PR_SET_PDEATHSIG failed')
    if os.getppid() != parent:
        raise SystemExit('Launching parent exited during registration')
    os.execvpe(sys.argv[3], sys.argv[3:], os.environ)

if __name__ == '__main__':
    main()
