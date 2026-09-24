import subprocess
import unittest
from native_pin_faults import CUDA_MACRO, diagnostic_sources, check_failure

class FaultHarness(unittest.TestCase):
    def test_variants_and_drift(self):
        text=CUDA_MACRO+'\n            vv=gpu_bench_valid_words(hs);\n'
        got=diagnostic_sources(text)
        self.assertIn('vv=1;',got['overflow'])
        self.assertIn('vv=gpu_bench_valid_words(hs);',got['cuda'])
        self.assertNotIn('QSB_DIAGNOSTIC',text)
        for bad in ('',text+text,text+'QSB_DIAGNOSTIC'):
            with self.assertRaises(ValueError):diagnostic_sources(bad)
    def test_fail_closed_checker(self):
        good=subprocess.CompletedProcess([],2,'','QSB_CUDA_DIAGNOSTIC ordinal=1 site=cudaMalloc\nQSB_RANGE_INCOMPLETE\n')
        check_failure(good,1)
        for code,out,err in [(0,'',good.stderr),(2,'QSB_RANGE_DRAINED',good.stderr),(2,'','QSB_RANGE_INCOMPLETE'),(2,'',good.stderr+'QSB_CUDA_DIAGNOSTIC ordinal=2 site=cudaMemcpy\n')]:
            with self.assertRaises(ValueError):check_failure(subprocess.CompletedProcess([],code,out,err),1)
