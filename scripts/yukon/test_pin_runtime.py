import base64
import copy
from pathlib import Path
import tempfile
import unittest
from pin_runtime import PROTOCOL,validate,result_records,run,sha

class PinRuntime(unittest.TestCase):
    def request(self,h='a'*64):
        raw=b'0'*156
        return {'protocol':PROTOCOL,'requestId':'public-test','manifestHash':'b'*64,'binarySha256':h,
                'parameterBase64':base64.b64encode(raw).decode(),'parameterSha256':sha(raw),
                'range':{'sequence':2**31,'sequenceCount':1,'locktime':500000000,'locktimeCount':1}}
    def test_request_rejection(self):
        good=self.request();validate(good,'a'*64)
        for key,value in [('protocol','qsb-config-a-v1'),('privateBackup','forbidden'),('binarySha256','c'*64),('parameterSha256','0'*64),('parameterBase64','!'),('range',{**good['range'],'sequenceCount':True}),('range',{**good['range'],'locktime':500000001})]:
            bad=copy.deepcopy(good);bad[key]=value
            with self.assertRaises(ValueError):validate(bad,'a'*64)
    def test_results_are_exact(self):
        r=self.request()['range'];marker='QSB_RANGE_DRAINED candidates=1'
        self.assertEqual(result_records(marker,'sequence=2147483648 locktime=500000000 recid=0',r)[0]['recid'],0)
        for log,text in [('', ''),(marker+'\n'+marker,''),('QSB_RANGE_DRAINED candidates=2',''),(marker,'garbage'),(marker,'sequence=2147483648 locktime=500000001 recid=0'),(marker,'sequence=2147483648 locktime=500000000 recid=0\n'*2)]:
            with self.assertRaises(ValueError):result_records(log,text,r)
    def test_real_process_contract_and_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'solver'
            for body,status in [('echo QSB_RANGE_DRAINED candidates=1','range-drained'),('exit 2','failed')]:
                p.write_text('#!/bin/sh\n'+body+'\n');p.chmod(0o700);h=sha(p.read_bytes())
                got=run(self.request(h),p,h)
                self.assertEqual(got['status'],status);self.assertFalse(got['rangeCreditEligible']);self.assertFalse(got['verified'])
            p.write_text('#!/bin/sh\nexit 0\n');h=sha(p.read_bytes())
            with self.assertRaises(ValueError):run(self.request(h),p,h)
            with self.assertRaises(ValueError):run(self.request(),p,'a'*64)
    def test_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'solver';p.write_text('#!/bin/sh\nsleep 30\n');p.chmod(0o700);h=sha(p.read_bytes())
            self.assertEqual(run(self.request(h),p,h,timeout=.05)['status'],'interrupted')
