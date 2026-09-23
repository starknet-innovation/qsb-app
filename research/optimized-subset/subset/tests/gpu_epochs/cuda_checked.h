#pragma once
// Host-only calls in main: evaluate once and reject before further work.
// Fault injection is compiled only into a separate diagnostic binary.
#ifdef QSB_CUDA_FAULT_TEST
static unsigned qsb_cuda_call_index=0;
template<class F> static cudaError_t qsb_cuda_test_call(F call,const char* label) {
    unsigned index=++qsb_cuda_call_index;
    fprintf(stderr,"QSB_CUDA_CALL %u %s\n",index,label);
    const char* fail=getenv("QSB_CUDA_FAIL_AT");
    if(fail && strtoul(fail,nullptr,10)==index)return cudaErrorUnknown;
    return call();
}
#define QSB_CUDA_EVALUATE(call) qsb_cuda_test_call([&](){return (call);},#call)
#else
#define QSB_CUDA_EVALUATE(call) (call)
#endif
#define QSB_CUDA_REQUIRE(call) do { \
    cudaError_t qsb_checked_error=QSB_CUDA_EVALUATE(call); \
    if(qsb_checked_error!=cudaSuccess){ \
        fprintf(stderr,"QSB_RANGE_INCOMPLETE: CUDA %s failed: %s\n",#call,cudaGetErrorString(qsb_checked_error)); \
        return 2; \
    } \
} while(0)
