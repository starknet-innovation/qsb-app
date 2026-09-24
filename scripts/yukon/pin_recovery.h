#pragma once
#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/obj_mac.h>
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

// Validate public scalar/point constants before table builders dereference them.
// Invalid constants and OpenSSL errors both reject the entire range.
static inline void qsb_validate_curve_inputs(const uint8_t nri_le[32],
        const uint8_t x_le[32], const uint8_t y_le[32]) {
    EC_GROUP *grp=EC_GROUP_new_by_curve_name(NID_secp256k1);
    qsb_require_host(grp != NULL, "curve allocation");
    BN_CTX *ctx=BN_CTX_new();
    qsb_require_host(ctx != NULL, "curve context allocation");
    BIGNUM *nri=BN_lebin2bn(nri_le,32,NULL), *x=BN_lebin2bn(x_le,32,NULL),
           *y=BN_lebin2bn(y_le,32,NULL), *order=BN_new(), *field=BN_new();
    qsb_require_host(nri && x && y && order && field, "curve constant allocation");
    qsb_require_host(EC_GROUP_get_order(grp,order,ctx)==1 &&
                    EC_GROUP_get_curve(grp,field,NULL,NULL,ctx)==1, "curve parameters");
    qsb_require_host(!BN_is_zero(nri) && BN_cmp(nri,order)<0 &&
                    BN_cmp(x,field)<0 && BN_cmp(y,field)<0, "canonical curve constants");
    EC_POINT *R=EC_POINT_new(grp);
    qsb_require_host(R != NULL, "input point allocation");
    qsb_require_host(EC_POINT_set_affine_coordinates(grp,R,x,y,ctx)==1 &&
                    EC_POINT_is_on_curve(grp,R,ctx)==1 &&
                    EC_POINT_is_at_infinity(grp,R)==0, "input point validation");
    EC_POINT_free(R);BN_free(nri);BN_free(x);BN_free(y);BN_free(order);BN_free(field);
    BN_CTX_free(ctx);EC_GROUP_free(grp);
}
