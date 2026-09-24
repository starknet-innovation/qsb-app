"""Execute the real compiled binary's rejection paths without a GPU."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile


def main(binary):
    cases=0
    with tempfile.TemporaryDirectory() as tmp:
        p=Path(tmp);bad=p/'invalid.bin';bad.write_bytes(b'bad')
        args=[str(bad),'0','2147483648','1','500000000','1']
        for changed in ([],args[:2],args+['easy'],args[:2]+['4294967295','2','500000000','1'],args[:2]+['2147483648','1','500000001','1']):
            r=subprocess.run([binary,*changed],capture_output=True,text=True,timeout=10)
            assert r.returncode==2 and 'Expected:' in r.stderr,(changed,r.returncode,r.stderr)
            assert 'QSB_RANGE_DRAINED' not in r.stdout
            cases+=1
        raw=struct.pack('>8I',*range(8))+struct.pack('<I',12)+bytes(12)+struct.pack('<III',12,0,4)+bytes(96)
        for payload in (b'',b'bad',raw[:-1],raw+b'extra',raw[:32]+struct.pack('<I',0xffffffff)+raw[36:]):
            bad.write_bytes(payload)
            r=subprocess.run([binary,*args],capture_output=True,text=True,timeout=10)
            assert r.returncode==2,(r.returncode,r.stderr)
            assert 'cuda' not in r.stderr.lower() and 'QSB_RANGE_DRAINED' not in r.stdout
            cases+=1
        bad.write_bytes(raw)
        r=subprocess.run([binary,*args],capture_output=True,text=True,timeout=10)
        assert r.returncode==2 and 'canonical curve constants' in r.stderr,(r.returncode,r.stderr)
        assert 'cuda' not in r.stderr.lower() and 'QSB_RANGE_DRAINED' not in r.stdout
        cases+=1
    print(json.dumps({'actualBinaryRejections':cases,'gpuUsed':False}))

if __name__=='__main__':main(sys.argv[1])
