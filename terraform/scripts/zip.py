"""Deterministic Lambda ZIPs; no credentials, host paths or dependency trees."""
from pathlib import Path
import sys, zipfile
root = Path(sys.argv[1])
for name in ('api', 'coordinator', 'reference', 'watchdog', 'dispatch'):
    with zipfile.ZipFile(root / (name + '.zip'), 'w', zipfile.ZIP_DEFLATED) as archive:
        for source in sorted((root / name).iterdir()):
            if not source.is_file():
                raise ValueError('Unexpected nested Lambda source')
            entry = zipfile.ZipInfo(source.name, (2020, 1, 1, 0, 0, 0))
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, source.read_bytes())
