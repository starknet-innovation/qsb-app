"""Extract the actual adapted GPU predicates and emit deterministic boundary tests."""
from pathlib import Path
import hashlib,json,sys
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'worker/cpu'))
from gpu_emulator import is_valid_der

def function(source,name):
    start=source.rfind('__device__',0,source.index(name+'('))
    body=source.index('{',source.index(name+'('));end=body+1;depth=1
    while depth:
        depth+=(source[end]=='{')-(source[end]=='}');end+=1
    return source[start:end]

pin=(ROOT/'worker/build/pinning/pinning.cu').read_text();sub=(ROOT/'worker/build/subset/tests/gpu_epochs/tree.cu').read_text()
functions=[]
for name in ('gpu_is_valid_der','gpu_bench_valid','gpu_bench_valid_words'):
    a,b=function(pin,name),function(sub,name)
    # The implementations are extracted independently; formatting can differ.
    functions.append(a.replace(name,'pin_'+name))
    functions.append(b.replace(name,'sub_'+name))
source='\n'.join(functions).replace('return gpu_is_valid_der(h, 32);','return pin_gpu_is_valid_der(h, 32);')
# Bind each extracted gate to its corresponding DER routine.
source=source.replace('sub_gpu_bench_valid(const uint8_t *h) {\n    return pin_', 'sub_gpu_bench_valid(const uint8_t *h) {\n    return sub_')
source=source.replace('return gpu_is_valid_der(digest, 32);','return pin_gpu_is_valid_der(digest, 32);')
start=source.index('sub_gpu_bench_valid_words');source=source[:start]+source[start:].replace('return pin_gpu_is_valid_der','return sub_gpu_is_valid_der')
valid=bytes([0x30,29,2,12])+bytes([0x11])*12+bytes([2,13])+bytes([0x22])*13+bytes([1])
vectors=[valid]
for pos in range(32):
    for value in (0,1,0x7f,0x80,0xff):
        v=bytearray(valid);v[pos]=value;vectors.append(bytes(v))
vectors.extend(hashlib.sha256(str(i).encode()).digest() for i in range(128))
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
(out/'gate-vectors.json').write_text(json.dumps([{'hex':v.hex(),'expected':int(is_valid_der(v))} for v in vectors]))
rows=','.join('{'+','.join(map(str,v))+'}' for v in vectors)
source='#include <cuda_runtime.h>\n#include <stdint.h>\n#include <stdio.h>\n'+source
source+='''
__global__ void gates(const uint8_t *data,int *out,int count){int i=threadIdx.x+blockIdx.x*blockDim.x;if(i>=count)return;const uint8_t *p=data+32*i;uint32_t w[8];for(int k=0;k<8;k++)w[k]=((uint32_t)p[4*k]<<24)|((uint32_t)p[4*k+1]<<16)|((uint32_t)p[4*k+2]<<8)|p[4*k+3];out[4*i]=pin_gpu_bench_valid(p);out[4*i+1]=pin_gpu_bench_valid_words(w);out[4*i+2]=sub_gpu_bench_valid(p);out[4*i+3]=sub_gpu_bench_valid_words(w);}
'''
source+=f'uint8_t data[{len(vectors)}][32]={{'+rows+'};\n'
source+='''int main(){const int count=sizeof(data)/32;uint8_t *d;int *r;int host[sizeof(data)/32*4];cudaMalloc(&d,sizeof(data));cudaMalloc(&r,sizeof(host));cudaMemcpy(d,data,sizeof(data),cudaMemcpyHostToDevice);gates<<<(count+127)/128,128>>>(d,r,count);if(cudaDeviceSynchronize()!=cudaSuccess)return 2;if(cudaMemcpy(host,r,sizeof(host),cudaMemcpyDeviceToHost)!=cudaSuccess)return 3;for(int i=0;i<count;i++)printf("GATE %d %d %d %d %d\\n",i,host[4*i],host[4*i+1],host[4*i+2],host[4*i+3]);cudaFree(d);cudaFree(r);return 0;}
'''
(out/'der-gates.cu').write_text(source)
