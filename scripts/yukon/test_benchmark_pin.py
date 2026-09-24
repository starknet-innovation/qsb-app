import unittest
from benchmark_pin import COUNTS,summarize

class BenchmarkPairs(unittest.TestCase):
    def test_startup_removed_and_incomplete_rejected(self):
        rows=[{'layout':0,'solver':s,'rep':r,'count':n,'wallSeconds':2+n/rate} for s,rate in [('baseline',1e8),('candidate',2e8)] for r in range(3) for n in COUNTS]
        self.assertAlmostEqual(summarize(rows)[0]['medianThroughputChangePercent'],100)
        with self.assertRaises(ValueError):summarize(rows[:-1])
        rows[-1]['wallSeconds']=0
        with self.assertRaises(ValueError):summarize(rows)
