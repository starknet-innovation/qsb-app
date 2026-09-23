// Host bridge; generic complete-range mode only. Resolve before accounting or
// publication. Every CUDA/OpenSSL failure keeps the whole range incomplete.
static bool qsb_exact_der(const unsigned char* d, bool easy, bool relaxed) {
    if(easy && !relaxed)return (d[0]>>4)==3;
    if((!relaxed && d[0]!=0x30)||d[1]!=29)return false;
    unsigned i=2;
    for(int p=0;p<2;p++){
        if(i>=31||d[i++]!=2)return false;
        unsigned n=d[i++];
        if(!n||i+n>31||(d[i]&128)||(n>1&&d[i]==0&&!(d[i+1]&128)))return false;
        i+=n;
    }
    return i==31;
}
static bool qsb_resolve_exceptions(uint32_t &count,uint32_t* device_tags,
        uint8_t* device_combos,uint8_t* device_z,const digest_params_t &dp,
        bool easy,bool single_hash,bool calibrate) {
    if(!count)return true;
    if(count>64)return false;
    uint32_t tags[64];
    if(cudaMemcpy(tags,device_tags,count*4,cudaMemcpyDeviceToHost)!=cudaSuccess)return false;
    bool any=false;for(unsigned i=0;i<count;i++)any|=(tags[i]&(1u<<29))!=0;
    if(!any)return true;
    uint8_t combos[64*MAX_T],scalars[64*32];
    if(cudaMemcpy(combos,device_combos,count*MAX_T,cudaMemcpyDeviceToHost)!=cudaSuccess ||
       cudaMemcpy(scalars,device_z,count*32,cudaMemcpyDeviceToHost)!=cudaSuccess)return false;
    unsigned kept=0;
    for(unsigned i=0;i<count;i++) {
        uint32_t tag=tags[i];bool accept=true;
        if(tag&(1u<<29)) {
            std::array<qsb_exact::Branch,2> branches;
            if(!qsb_exact::recover(scalars+i*32,dp.neg_r_inv,dp.u2r_x,dp.u2r_y,branches))return false;
            accept=false;
            for(unsigned ri=0;ri<2&&!accept;ri++)if(branches[ri].finite) {
                unsigned char digest[32];
                if(!SHA256(branches[ri].key.data(),33,digest))return false;
                for(unsigned hc=0;hc<(single_hash?1u:2u);hc++) {
                    if(hc){unsigned char next[32];if(!SHA256(digest,32,next))return false;memcpy(digest,next,32);}
                    if(qsb_exact_der(digest,easy,calibrate)) {
                        tag=(tag&((1u<<29)-1))|(ri<<30)|(hc<<31);accept=true;break;
                    }
                }
            }
        }
        if(accept){tags[kept]=tag;memmove(combos+kept*MAX_T,combos+i*MAX_T,MAX_T);kept++;}
    }
    if(kept && (cudaMemcpy(device_tags,tags,kept*4,cudaMemcpyHostToDevice)!=cudaSuccess ||
                cudaMemcpy(device_combos,combos,kept*MAX_T,cudaMemcpyHostToDevice)!=cudaSuccess))return false;
    count=kept;return true;
}
