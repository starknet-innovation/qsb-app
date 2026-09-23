#pragma once
#include <array>
#include <cstdint>
#include <memory>
#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/obj_mac.h>

namespace qsb_exact {
struct Branch { bool finite = false; std::array<unsigned char,33> key{}; };
// Public inputs only, all 32-byte integers little-endian. Return false on any
// invalid parameter or library failure; an infinite branch is not an error.
// Branch 0 is P+R and branch 1 P-R, P=(z*negative_r_inverse mod n)*G.
inline bool recover(const unsigned char z[32], const unsigned char nri[32],
                    const unsigned char rx[32], const unsigned char ry[32],
                    std::array<Branch,2>& output) {
    output = {};
    using BN = std::unique_ptr<BIGNUM, decltype(&BN_free)>;
    using Point = std::unique_ptr<EC_POINT, decltype(&EC_POINT_free)>;
    std::unique_ptr<BN_CTX, decltype(&BN_CTX_free)> ctx(BN_CTX_new(),BN_CTX_free);
    std::unique_ptr<EC_GROUP, decltype(&EC_GROUP_free)> group(
        EC_GROUP_new_by_curve_name(NID_secp256k1),EC_GROUP_free);
    if(!ctx || !group) return false;
    BN bz(BN_lebin2bn(z,32,nullptr),BN_free), bnri(BN_lebin2bn(nri,32,nullptr),BN_free);
    BN x(BN_lebin2bn(rx,32,nullptr),BN_free), y(BN_lebin2bn(ry,32,nullptr),BN_free);
    BN n(BN_new(),BN_free), p(BN_new(),BN_free), scalar(BN_new(),BN_free);
    Point r(EC_POINT_new(group.get()),EC_POINT_free), q(EC_POINT_new(group.get()),EC_POINT_free);
    Point sum(EC_POINT_new(group.get()),EC_POINT_free);
    if(!bz||!bnri||!x||!y||!n||!p||!scalar||!r||!q||!sum) return false;
    if(EC_GROUP_get_order(group.get(),n.get(),ctx.get())!=1 ||
       EC_GROUP_get_curve(group.get(),p.get(),nullptr,nullptr,ctx.get())!=1) return false;
    if(BN_is_zero(bnri.get()) || BN_cmp(bnri.get(),n.get())>=0 ||
       BN_cmp(x.get(),p.get())>=0 || BN_cmp(y.get(),p.get())>=0) return false;
    if(EC_POINT_set_affine_coordinates(group.get(),r.get(),x.get(),y.get(),ctx.get())!=1 ||
       EC_POINT_is_on_curve(group.get(),r.get(),ctx.get())!=1 ||
       BN_mod_mul(scalar.get(),bz.get(),bnri.get(),n.get(),ctx.get())!=1 ||
       EC_POINT_mul(group.get(),q.get(),scalar.get(),nullptr,nullptr,ctx.get())!=1) return false;
    std::array<Branch,2> result{};
    for(int i=0;i<2;i++) {
        if(i && EC_POINT_invert(group.get(),r.get(),ctx.get())!=1) return false;
        if(EC_POINT_add(group.get(),sum.get(),q.get(),r.get(),ctx.get())!=1) return false;
        int infinity=EC_POINT_is_at_infinity(group.get(),sum.get());
        if(infinity==1) continue;
        if(infinity!=0 || EC_POINT_is_on_curve(group.get(),sum.get(),ctx.get())!=1) return false;
        if(EC_POINT_point2oct(group.get(),sum.get(),POINT_CONVERSION_COMPRESSED,
              result[i].key.data(),result[i].key.size(),ctx.get())!=33) return false;
        result[i].finite=true;
    }
    output=result;
    return true;
}
}
