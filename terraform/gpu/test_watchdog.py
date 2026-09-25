"""Exercise stale-job detection without credentials or AWS calls."""
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

class WatchdogTests(unittest.TestCase):
    def test_only_stale_scoped_jobs_are_terminated_without_resubmission(self):
        batch=Mock()
        batch.get_paginator.return_value.paginate.return_value=[{'jobSummaryList':[{'jobId':'old','createdAt':1},{'jobId':'new','createdAt':10**16}]}]
        batch.describe_jobs.return_value={'jobs':[{'jobId':'old','jobQueue':'q','tags':{'Project':'qsb-gpu'}}]}
        modules={'boto3':types.SimpleNamespace(client=lambda *a,**k:batch),'botocore':types.ModuleType('botocore'),'botocore.config':types.SimpleNamespace(Config=lambda **k:k)}
        with patch.dict(sys.modules,modules),patch.dict(os.environ,{'JOB_QUEUE':'q'}):
            spec=importlib.util.spec_from_file_location('watchdog',Path(__file__).with_name('watchdog.py'))
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            result=module.handler({},None)
            self.assertEqual(result,{'terminated':['old']*5})
            batch.terminate_job.assert_called_with(jobId='old',reason='QSB 30-minute submission age ceiling')
            batch.submit_job.assert_not_called()
            batch.describe_jobs.return_value={'jobs':[{'jobId':'old','jobQueue':'other','tags':{'Project':'qsb-gpu'}}]}
            before=batch.terminate_job.call_count
            with self.assertRaisesRegex(RuntimeError,'Unexpected job identity'):module.handler({},None)
            self.assertEqual(before,batch.terminate_job.call_count)
            for tags in ({'Project':'unrelated'}, {}):
                batch.describe_jobs.return_value={'jobs':[{'jobId':'old','jobQueue':'q','tags':tags}]}
                with self.assertRaisesRegex(RuntimeError,'Unexpected job identity'):module.handler({},None)
                self.assertEqual(before,batch.terminate_job.call_count)

if __name__=='__main__':unittest.main()
