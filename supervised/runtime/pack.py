"""Deterministic tar/gzip: fixed ordering, owner, permissions and timestamps."""
import gzip,io,pathlib,sys,tarfile
src=pathlib.Path(sys.argv[1]);target=pathlib.Path(sys.argv[2])
with target.open('wb') as raw,gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as zipped,tarfile.open(fileobj=zipped,mode='w') as archive:
 for p in sorted(src.rglob('*')):
  if p.is_symlink():raise ValueError('Symlink in package')
  if not p.is_file():continue
  data=p.read_bytes();t=tarfile.TarInfo(str(p.relative_to(src)));t.size=len(data);t.mode=0o644;t.mtime=0;t.uid=t.gid=0;t.uname=t.gname='';archive.addfile(t,io.BytesIO(data))
