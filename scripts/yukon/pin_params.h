#pragma once
#include <string.h>
// Serialized format: BE midstate words; LE lengths/offsets and scalar limbs.
typedef struct {
    uint32_t midstate[8];
    uint32_t suffix_len;
    uint8_t *suffix;
    uint32_t total_preimage_len, seq_offset, lt_offset;
    uint8_t neg_r_inv[32], u2r_x[32], u2r_y[32];
} pinning2_params_t;
static inline uint32_t qsb_read_le32(const uint8_t *b) {
    return (uint32_t)b[0] | ((uint32_t)b[1]<<8) |
        ((uint32_t)b[2]<<16) | ((uint32_t)b[3]<<24);
}
static int load_pinning2(const char *name, pinning2_params_t *p) {
    memset(p, 0, sizeof(*p));
    FILE *f = fopen(name, "rb");
    if (!f) return -1;
    uint8_t raw[264]; // One byte beyond the largest supported two-block suffix.
    size_t n = fread(raw, 1, sizeof(raw), f);
    int failed = ferror(f);
    if (fclose(f) != 0) failed = 1;
    if (failed || n < 36 || n == sizeof(raw)) return -1;
    uint32_t sl = qsb_read_le32(raw+32);
    if (sl < 8 || sl > 119 || n != (size_t)(144+sl)) return -1;
    const uint8_t *tail = raw+36+sl;
    uint32_t total=qsb_read_le32(tail), so=qsb_read_le32(tail+4), lo=qsb_read_le32(tail+8);
    if (total < sl || (total-sl)%64 != 0 || so > sl-4 || lo > sl-8 ||
        !((uint64_t)so+4 <= lo || (uint64_t)lo+8 <= so)) return -1;
    uint8_t *suffix=(uint8_t*)calloc((size_t)sl+16,1);
    if (!suffix) return -1;
    memcpy(suffix,raw+36,sl);
    for(int i=0;i<8;i++) {
        const uint8_t *b=raw+4*i;
        p->midstate[i]=((uint32_t)b[0]<<24)|((uint32_t)b[1]<<16)|((uint32_t)b[2]<<8)|b[3];
    }
    p->suffix=suffix;p->suffix_len=sl;p->total_preimage_len=total;
    p->seq_offset=so;p->lt_offset=lo;
    memcpy(p->neg_r_inv,tail+12,32);memcpy(p->u2r_x,tail+44,32);memcpy(p->u2r_y,tail+76,32);
    return 0;
}
