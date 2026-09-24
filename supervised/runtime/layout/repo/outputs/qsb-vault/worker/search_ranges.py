"""Deterministic disjoint batches; interrupted batches are replayed in full."""
from math import comb
VERSION = 'ranked-v2'
CHUNK = 1 << 34
LT_MIN, LT_END = 500000000, 1744600000
LT_SPAN = LT_END - LT_MIN
SEQUENCES = 16
SUBSET_TOTAL = comb(150, 9)
def work_range(stage, attempt):
    if type(attempt) is not int or attempt < 0: raise ValueError('Invalid work unit')
    if stage == 'pinning':
        seq_offset = attempt * SEQUENCES
        if seq_offset >= 1 << 31: raise ValueError('Search range exhausted')
        return {'version': VERSION, 'start': str(seq_offset * LT_SPAN),
            'count': SEQUENCES * LT_SPAN, 'sequence': 0x80000000 + seq_offset,
            'sequenceCount': SEQUENCES, 'locktime': LT_MIN}
    if stage not in ('round1', 'round2'): raise ValueError('Invalid stage')
    start = attempt * CHUNK
    if start >= SUBSET_TOTAL: raise ValueError('Search range exhausted')
    return {'version': VERSION, 'start': str(start), 'count': min(CHUNK, SUBSET_TOTAL - start)}
