"""Two-size wall-time model. Projections are not measured attempt costs."""
import math
import statistics

RANGE_SIZES = (2**26, 2**30)
ATTEMPT_RANKS = 2**34
REPETITIONS = 3


def estimate(runs, hourly_usd):
    if isinstance(hourly_usd, bool) or not math.isfinite(hourly_usd) or hourly_usd <= 0:
        raise ValueError('A positive finite verified hourly USD price is required')
    models = {}
    for stage in ('round1', 'round2'):
        samples = [r for r in runs if r['stage'] == stage]
        if len(samples) != 2 * REPETITIONS:
            raise ValueError('Incomplete benchmark; no projection')
        medians = []
        for size in RANGE_SIZES:
            group = [r for r in samples if r['ranks'] == size]
            if len(group) != REPETITIONS or {r['repetition'] for r in group} != set(range(REPETITIONS)):
                raise ValueError('Missing or duplicate probe')
            times = [r['elapsedIncludingStartupSeconds'] for r in group]
            if any(not math.isfinite(t) or t <= 0 for t in times):
                raise ValueError('Invalid wall time')
            medians.append(statistics.median(times))
        slope = (medians[1] - medians[0]) / (RANGE_SIZES[1] - RANGE_SIZES[0])
        intercept = medians[0] - slope * RANGE_SIZES[0]
        if slope <= 0 or intercept < 0 or not all(map(math.isfinite, (slope, intercept))):
            raise ValueError(f'{stage}: nonphysical two-size model; no projection')
        attempt = intercept + ATTEMPT_RANKS * slope
        if not all(map(math.isfinite, (1/slope, attempt, attempt * hourly_usd / 3600))):
            raise ValueError('Nonfinite projection')
        models[stage] = dict(
            rangeSizes=list(RANGE_SIZES), medianWallSeconds=medians,
            startupInterceptSeconds=intercept, steadySecondsPerRank=slope,
            steadyRanksPerSecond=1/slope,
            extrapolatedAttemptRanks=ATTEMPT_RANKS,
            extrapolatedAttemptSeconds=attempt,
            extrapolatedAttemptComputeUsd=attempt * hourly_usd / 3600,
            hourlyComputeUsd=hourly_usd,
            measuredAttempt=False,
            limitations='Two-point extrapolation; excludes instance boot/setup, idle, storage, transfer and full-search variability',
        )
    return models
