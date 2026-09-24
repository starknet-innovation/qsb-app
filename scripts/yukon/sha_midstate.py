"""Export public full-block SHA-256 state through checked host OpenSSL."""
import functools
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

@functools.lru_cache(maxsize=8)
def midstate(prefix):
    if len(prefix)%64:raise ValueError('SHA prefix must contain complete blocks')
    code=r'''#include <openssl/sha.h>
#include <stdio.h>
int main(){SHA256_CTX ctx;if(SHA256_Init(&ctx)!=1)return 2;
unsigned char b[64];size_t n;
while((n=fread(b,1,64,stdin))==64)SHA256_Transform(&ctx,b);
if(n||ferror(stdin))return 2;
for(int i=0;i<8;i++)printf("%08x",ctx.h[i]);return 0;}
'''
    with tempfile.TemporaryDirectory() as tmp:
        p=Path(tmp);(p/'sha.cpp').write_text(code);flags=[]
        if sys.platform=='darwin':flags=['-I/opt/homebrew/opt/openssl@3/include','-L/opt/homebrew/opt/openssl@3/lib']
        subprocess.run(['c++',*flags,str(p/'sha.cpp'),'-lcrypto','-o',str(p/'sha')],check=True,capture_output=True)
        out=subprocess.run([str(p/'sha')],input=prefix,capture_output=True,check=True).stdout
    return struct.unpack('>8I',bytes.fromhex(out.decode()))
