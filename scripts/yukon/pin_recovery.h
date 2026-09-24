#pragma once
#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/sha.h>
// Recover and hash one public point. Infinity is a legitimate non-candidate;
// allocation/arithmetic/serialization failures terminate without range credit.
static inline int qsb_recover_hash(const uint8_t digest[32], int recid,
        EC_GROUP *grp, BN_CTX *ctx, const BIGNUM *order,
        const BIGNUM *nri, const EC_POINT *Ru2, uint8_t hash[32]) {
    qsb_require_host(grp && ctx && order && nri && Ru2 && (recid == 0 || recid == 1), "recovery inputs");
    BIGNUM *z = BN_bin2bn(digest, 32, NULL);
    qsb_require_host(z != NULL, "digest scalar allocation");
    BIGNUM *u1 = BN_new();
    qsb_require_host(u1 != NULL, "recovery scalar allocation");
    EC_POINT *P = EC_POINT_new(grp);
    qsb_require_host(P != NULL, "P allocation");
    EC_POINT *Q = EC_POINT_new(grp);
    qsb_require_host(Q != NULL, "Q allocation");
    EC_POINT *R = EC_POINT_dup(Ru2, grp);
    qsb_require_host(R != NULL, "R allocation");
    qsb_require_host(BN_mod_mul(u1, z, nri, order, ctx) == 1, "scalar reduction");
    qsb_require_host(EC_POINT_mul(grp, P, u1, NULL, NULL, ctx) == 1, "scalar multiplication");
    if (recid) qsb_require_host(EC_POINT_invert(grp, R, ctx) == 1, "point inversion");
    qsb_require_host(EC_POINT_add(grp, Q, P, R, ctx) == 1, "point addition");
    int infinity = EC_POINT_is_at_infinity(grp, Q);
    qsb_require_host(infinity == 0 || infinity == 1, "infinity test");
    if (!infinity) {
        uint8_t pub[33];
        qsb_require_host(EC_POINT_point2oct(grp, Q, POINT_CONVERSION_COMPRESSED,
                           pub, sizeof(pub), ctx) == sizeof(pub), "compressed point serialization");
        qsb_require_host(SHA256(pub, sizeof(pub), hash) != NULL, "public point hash");
    }
    BN_free(z); BN_free(u1);
    EC_POINT_free(P); EC_POINT_free(Q); EC_POINT_free(R);
    return !infinity;
}
