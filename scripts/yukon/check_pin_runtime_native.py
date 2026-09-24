"""Actual compiled binary, synthetic public parameters, no-GPU CI boundary."""
import base64
import json
from pathlib import Path
import struct
import sys
from native_pin import IV
from test_pin_recovery import G
from pin_runtime import PROTOCOL,run,sha

binary=Path(sys.argv[1]);h=sha(binary.read_bytes())
suffix=bytes(8)+struct.pack('<I',1)
raw=struct.pack('>8I',*IV)+struct.pack('<I',12)+suffix+struct.pack('<III',12,0,4)
raw+=(1).to_bytes(32,'little')+G[0].to_bytes(32,'little')+G[1].to_bytes(32,'little')
request={'protocol':PROTOCOL,'requestId':'ci-no-gpu','manifestHash':'b'*64,'binarySha256':h,
         'parameterBase64':base64.b64encode(raw).decode(),'parameterSha256':sha(raw),
         'range':{'sequence':2147483648,'sequenceCount':1,'locktime':500000000,'locktimeCount':1}}
r=run(request,binary,h,timeout=30)
assert r['status']=='failed' and r['candidates']==[] and not r['rangeCreditEligible'] and not r['verified'],r
print(json.dumps({'actualBinary':True,'gpuAvailable':False,'result':r,'freshWithdrawal':False},indent=2))
