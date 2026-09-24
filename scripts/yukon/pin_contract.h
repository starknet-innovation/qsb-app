#pragma once
#include <stdint.h>
#include <stdio.h>
#ifdef __CUDACC__
#define QSB_HD __host__ __device__
#else
#define QSB_HD
#endif
// Strict DER structure for a 32-byte hash interpreted as signature+sighash.
// The reference deliberately does not constrain the final sighash byte here.
QSB_HD static inline int qsb_der32(const uint8_t *d) {
    if (d[0] != 0x30 || d[1] != 29) return 0;
    unsigned pos = 2;
    for (unsigned part = 0; part < 2; ++part) {
        if (pos + 2 > 31 || d[pos++] != 0x02) return 0;
        unsigned n = d[pos++];
        if (!n || pos + n > 31 || (d[pos] & 0x80)) return 0;
        if (n > 1 && d[pos] == 0 && !(d[pos + 1] & 0x80)) return 0;
        pos += n;
    }
    return pos == 31;
}
static inline int qsb_require_hit_capacity(uint32_t count) {
    if (count > 64) {
        fprintf(stderr, "QSB_RANGE_INCOMPLETE: hit capacity exceeded (%u)\n", count);
        return 0;
    }
    return 1;
}
#undef QSB_HD

// Decimal-only public range contract. Bounds are exclusive and widened before
// addition; even the final uint32 sequence/locktime cannot wrap the scheduler.
struct qsb_pin_range {
    uint64_t sequence_start, sequence_count, locktime_start, locktime_count;
};
static inline int qsb_parse_decimal(const char *s, uint64_t *out) {
    if (!s || !*s) return 0;
    uint64_t n = 0;
    for (; *s; ++s) {
        if (*s < '0' || *s > '9') return 0;
        unsigned d = (unsigned)(*s - '0');
        if (n > (UINT64_MAX - d) / 10) return 0;
        n = n * 10 + d;
    }
    *out = n;
    return 1;
}
static inline int qsb_valid_range(const qsb_pin_range *r) {
    const uint64_t end = UINT64_C(4294967296);
    return r->sequence_start >= UINT64_C(2147483648) &&
        r->sequence_start < end && r->sequence_count > 0 &&
        r->sequence_count <= 16 && r->sequence_count <= end-r->sequence_start &&
        r->locktime_start >= 500000000 && r->locktime_start < end &&
        r->locktime_start % 256 == 0 && r->locktime_count > 0 &&
        r->locktime_count <= end-r->locktime_start;
}
static inline uint32_t qsb_batch_size(uint64_t remaining, uint32_t batch) {
    return remaining < batch ? (uint32_t)remaining : batch;
}
