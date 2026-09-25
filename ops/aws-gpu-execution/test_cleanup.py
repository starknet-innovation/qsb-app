import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

class CleanupTests(unittest.TestCase):
    def load(self):
        fake=types.SimpleNamespace(client=lambda *a,**k: self)
        spec=importlib.util.spec_from_file_location('guard',Path(__file__).with_name('cleanup.py'))
        module=importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules,{'boto3':fake,'botocore.config':types.SimpleNamespace(Config=lambda **k:k)}): spec.loader.exec_module(module)
        return module
    def get_paginator(self,name): return self
    def paginate(self,**kwargs):
        self.filters=kwargs['Filters']
        return [{'Reservations':[{'Instances':[{'InstanceId':'i-target'}]}]}]
    def terminate_instances(self,**kwargs): self.terminated=kwargs['InstanceIds']
    def test_deadline_and_exact_tag_filter(self):
        module=self.load()
        with patch.dict(os.environ,{'DEADLINE':'100','RUN_TOKEN':'unique'}):
            with patch.object(module.time,'time',return_value=99): self.assertEqual(module.handler({},None),{'status':'armed'})
            self.assertFalse(hasattr(self,'terminated'))
            with patch.object(module.time,'time',return_value=100): self.assertEqual(module.handler({},None),{'terminated':['i-target']})
        self.assertIn({'Name':'tag:QsbBenchmarkToken','Values':['unique']},self.filters)
        self.assertEqual(self.terminated,['i-target'])

if __name__=='__main__': unittest.main()
