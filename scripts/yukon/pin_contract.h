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
