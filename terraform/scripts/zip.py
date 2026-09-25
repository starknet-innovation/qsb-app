"""Deterministic Lambda ZIPs; no credentials, host paths or dependency trees."""
from pathlib import Path
import sys, zipfile
root = Path(sys.argv[1])
for name in ('api', 'coordinator', 'reference'):
    with zipfile.ZipFile(root / (name + '.zip'), 'w', zipfile.ZIP_DEFLATED) as archive:
        for source in sorted((root / name).rglob('*')):
            if not source.is_file():
                continue
            entry = zipfile.ZipInfo(source.relative_to(root / name).as_posix(), (2020, 1, 1, 0, 0, 0))
            entry.external_attr = (0o100755 if source.name == 'qsb-consensus' else 0o100644) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, source.read_bytes())
