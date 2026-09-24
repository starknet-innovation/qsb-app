"""Real OpenSSL differential for the adapted public recovery helper."""
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def add(a, b):
    if a is None: return b
    if b is None: return a
    x,y=a;u,v=b
    if x==u and (y+v)%P==0:return None
    m=((3*x*x)*pow(2*y,-1,P) if a==b else (v-y)*pow(u-x,-1,P))%P
    w=(m*m-x-u)%P
    return w,(m*(x-w)-y)%P


def mul(n):
    a=None;b=G
    while n:
        if n&1:a=add(a,b)
        b=add(b,b);n>>=1
    return a


class RecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();cls.path=Path(cls.tmp.name)
        code=r'''#include "pin_contract.h"
#include <openssl/obj_mac.h>
static int checks=0, fail_at=0;
static void injected_check(int ok,const char *op) {
    ++checks;
    qsb_require_host(ok && checks!=fail_at,op);
}
#define qsb_require_host injected_check
#include "pin_recovery.h"
#undef qsb_require_host
int main(int argc,char**argv) {
    if(argc==4) {
        uint8_t v[3][32];
        for(int i=0;i<3;i++) {
            BIGNUM *b=NULL;
            if(!BN_hex2bn(&b,argv[i+1])||BN_bn2lebinpad(b,v[i],32)!=32)return 9;
            BN_free(b);
        }
        qsb_validate_curve_inputs(v[0],v[1],v[2]);
        puts("validated");return 0;
    }
    if(argc!=5)return 9;
    EC_GROUP *g=EC_GROUP_new_by_curve_name(NID_secp256k1);
    BN_CTX *c=BN_CTX_new();BIGNUM *order=BN_new(),*nri=BN_new(),*z=NULL;
    if(!g||!c||!order||!nri||!BN_hex2bn(&z,argv[1])||
       !BN_set_word(nri,strtoul(argv[2],NULL,10))||!EC_GROUP_get_order(g,order,c))return 9;
    uint8_t d[32],h[32];if(BN_bn2binpad(z,d,32)!=32)return 9;
    fail_at=atoi(argv[4]);
    int result=qsb_recover_hash(d,atoi(argv[3]),g,c,order,nri,EC_GROUP_get0_generator(g),h);
    if(result)for(int i=0;i<32;i++)printf("%02x",h[i]);else printf("infinity");
    printf("\nchecks=%d\n",checks);
    BN_free(z);BN_free(nri);BN_free(order);BN_CTX_free(c);EC_GROUP_free(g);
}
'''
        (cls.path/'test.cpp').write_text(code)
        flags=[]
        if sys.platform=='darwin':
            root=Path('/opt/homebrew/opt/openssl@3')
            flags=['-I'+str(root/'include'),'-L'+str(root/'lib')]
        subprocess.run(['c++','-std=c++17','-I',str(Path(__file__).parent),*flags,str(cls.path/'test.cpp'),'-lcrypto','-o',str(cls.path/'test')],check=True,capture_output=True)

    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()

    def run_case(self,z,nri,sign,fail=0):
        return subprocess.run([str(self.path/'test'),f'{z:064x}',str(nri),str(sign),str(fail)],capture_output=True,text=True)

    def test_real_curve_differential(self):
        scalars=[0,1,2,3,N-1,N,N+1,2**256-1]
        scalars += [int.from_bytes(hashlib.sha256(f'public-recovery-{i}'.encode()).digest(),'big') for i in range(16)]
        for z in scalars:
            for nri in (1,7):
                for sign in (0,1):
                    with self.subTest(z=z,nri=nri,sign=sign):
                        point=mul((z*nri+(1 if sign==0 else -1))%N)
                        want='infinity' if point is None else hashlib.sha256(bytes([2+(point[1]&1)])+point[0].to_bytes(32,'big')).hexdigest()
                        got=self.run_case(z,nri,sign)
                        self.assertEqual(got.returncode,0,got.stderr)
                        self.assertEqual(got.stdout.splitlines()[0],want)

    def test_curve_input_validation(self):
        cases=[(1,*G,True),(N-1,*G,True),(1,G[0],P-G[1],True),
               (0,*G,False),(N,*G,False),(1,0,0,False),
               (1,P,G[1],False),(1,G[0],P,False),(1,G[0],G[1]^1,False)]
        for nri,x,y,valid in cases:
            out=subprocess.run([str(self.path/'test'),f'{nri:064x}',f'{x:064x}',f'{y:064x}'],capture_output=True,text=True)
            self.assertEqual(out.returncode,0 if valid else 2)
            self.assertEqual(out.stdout,'validated\n' if valid else '')

    def test_each_checked_failure_stops_publication(self):
        normal=self.run_case(2,1,1)
        self.assertEqual(normal.returncode,0)
        count=int(normal.stdout.splitlines()[1].split('=')[1])
        self.assertEqual(count,13)
        for step in range(1,count+1):
            got=self.run_case(2,1,1,step)
            self.assertEqual(got.returncode,2,(step,got.stderr))
            self.assertEqual(got.stdout,'')
            self.assertIn('QSB_RANGE_INCOMPLETE',got.stderr)

if __name__=='__main__':unittest.main()
