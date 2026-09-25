import copy
import math
import unittest
from model import ATTEMPT_RANKS, RANGE_SIZES, estimate


def probes():
    return [dict(stage=stage, ranks=n, repetition=i,
                 elapsedIncludingStartupSeconds=3 + n / 100_000_000 + (i-1)*.1)
            for stage in ('round1', 'round2') for n in RANGE_SIZES for i in range(3)]


class TimingModelTests(unittest.TestCase):
    def test_known_startup_slope_and_compute_price(self):
        for result in estimate(probes(), 1.2).values():
            self.assertAlmostEqual(result['startupInterceptSeconds'], 3)
            self.assertAlmostEqual(result['steadyRanksPerSecond'], 100_000_000)
            self.assertAlmostEqual(result['extrapolatedAttemptSeconds'], 3 + ATTEMPT_RANKS/100_000_000)
            self.assertAlmostEqual(result['extrapolatedAttemptComputeUsd'], (3 + ATTEMPT_RANKS/100_000_000)/3000)
            self.assertFalse(result['measuredAttempt'])

    def test_medians_resist_one_slow_probe_at_each_size(self):
        runs = probes()
        for row in runs:
            if row['repetition'] == 2: row['elapsedIncludingStartupSeconds'] += 100
        result = estimate(runs, 1)['round1']
        self.assertAlmostEqual(result['startupInterceptSeconds'], 3)

    def test_incomplete_duplicate_and_wrong_range_refused(self):
        for change in ('missing', 'duplicate', 'wrong-range'):
            runs = probes()
            if change == 'missing': runs.pop()
            elif change == 'duplicate': runs[0]['repetition'] = 1
            else: runs[0]['ranks'] += 1
            with self.subTest(change=change), self.assertRaises(ValueError): estimate(runs, 1)

    def test_nonphysical_models_publish_no_cost(self):
        for small, large in [(10, 9), (10, 10), (1, 100), (float('inf'), 12), (float('nan'), 12), (0, 12)]:
            runs = probes()
            for row in runs:
                row['elapsedIncludingStartupSeconds'] = small if row['ranks'] == RANGE_SIZES[0] else large
            with self.subTest(small=small, large=large), self.assertRaises(ValueError): estimate(runs, 1)

    def test_invalid_prices_refused(self):
        for value in (0, -1, float('inf'), float('nan'), True):
            with self.subTest(price=value), self.assertRaises(ValueError): estimate(probes(), value)
