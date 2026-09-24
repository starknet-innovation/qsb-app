import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import pin_queue as queue

class Queue(unittest.TestCase):
    def setup(self,root,body):
        p=root/'scripts/yukon';p.mkdir(parents=True)
        (p/'pin_worker.py').write_text(body)
        (root/'pin_queue.py').write_text('fixture queue artifact')
        (root/'requirements.lock').write_text('fixture dependency lock')
        (root/'runtime-manifest.json').write_text(json.dumps({'files':{'bin/pinning':'a'*64}}))
        files={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in ('pin_queue.py','requirements.lock','runtime-manifest.json')}
        (root/'queue-binding.json').write_text(json.dumps({'format':'qsb-yukon-pin-queue-v1','dispatchAuthorized':False,'files':files}))
        request={'protocol':'qsb-yukon-pinning-research-v1','requestId':'test','manifestHash':'b'*64,'binarySha256':'a'*64,'parameterSha256':'c'*64,'range':{'sequence':2147483648,'sequenceCount':1,'locktime':500000000,'locktimeCount':1}}
        return {'id':'synthetic-id','input':{'runtimeManifestSha256':files['runtime-manifest.json'],'request':request}}
    def test_real_child_preserves_binding_and_excludes_credentials(self):
        body="import json,sys,os\nassert 'RUNPOD_API_KEY' not in os.environ\nr=json.load(sys.stdin)['request'];r.update(status='range-drained',candidates=[],verified=False,rangeCreditEligible=False,releaseStatus='HOLD');print(json.dumps(r))"
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);job=self.setup(root,body)
            with patch.object(queue,'ROOT',root),patch.dict(os.environ,{'RUNPOD_API_KEY':'public-test-placeholder'}):
                out=queue.handler(job)
            self.assertEqual(out['providerJobId'],job['id']);self.assertFalse(out['output']['rangeCreditEligible'])
    def test_failure_timeout_malformed_and_excessive_output(self):
        for body in ['raise SystemExit(2)','print("not json")','import time;time.sleep(10)','print("x"*3000000)']:
            with self.subTest(body=body),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);job=self.setup(root,body)
                with patch.object(queue,'ROOT',root),patch.object(queue,'TIMEOUT',.1):
                    with self.assertRaises((ValueError,subprocess.TimeoutExpired)):queue.handler(job)
    def test_tamper_and_wrong_manifest_reject_before_child(self):
        for mode in ('artifact','manifest'):
            with tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);job=self.setup(root,'raise SystemExit("must not run")')
                if mode=='artifact':(root/'pin_queue.py').write_text('changed')
                else:job['input']['runtimeManifestSha256']='d'*64
                with patch.object(queue,'ROOT',root),patch.object(queue.subprocess,'Popen') as child:
                    with self.assertRaises(ValueError):queue.handler(job)
                    child.assert_not_called()
