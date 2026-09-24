import unittest
from subprocess import CompletedProcess
from native_pin_async import instrument,check

class AsyncHarness(unittest.TestCase):
    def test_expression_rewrite(self):
        text='// cudaEventRecord(x);\nconst char*s="cudaMemcpyAsync(x)";\ne = cudaMemcpyAsync(p, f(1,2), 4, dir, st);\nif(e==0)e=cudaEventRecord(done,st);\ncudaFree(p);'
        got,sites=instrument(text,'test')
        self.assertEqual(len(sites),2)
        self.assertIn('qsb_async_diagnostic(cudaMemcpyAsync(p, f(1,2), 4, dir, st), "test:3:cudaMemcpyAsync")',got)
        self.assertIn('cudaFree(p);',got)
        with self.assertRaises(ValueError):instrument('cudaEventRecord(', 'test')
    def test_reject_completion_and_late_calls(self):
        stderr='QSB_ASYNC_DIAGNOSTIC ordinal=1 site=x\n'
        check(CompletedProcess([],1,'',stderr),1)
        for r in (CompletedProcess([],0,'',stderr),CompletedProcess([],1,'QSB_RANGE_DRAINED',stderr),CompletedProcess([],1,'',stderr+'QSB_ASYNC_DIAGNOSTIC ordinal=2 site=y\n')):
            with self.assertRaises(ValueError):check(r,1)
