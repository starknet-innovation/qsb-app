from pathlib import Path
import subprocess
import tempfile
import unittest
from check_openssl import checked_openssl

class OpenSSLChecks(unittest.TestCase):
    def test_checked_api_inventory_does_not_change_length_or_comparison_semantics(self):
        raw='int a=BN_cmp(x,y); int b=BN_num_bytes(x); BN_free(x); BN_mod_inverse(x,y,p,c);'
        got,sites=checked_openssl(raw)
        self.assertEqual(got,raw);self.assertEqual(sites,[])
        raw='// BN_new()\nconst char*s="BN_new()"; auto x=BN_new(); if(BN_copy(x,y)) return 1;'
        got,sites=checked_openssl(raw)
        self.assertEqual(sites,['BN_new','BN_copy'])
        self.assertIn('auto x=qsb_ssl_checked(BN_new(), "BN_new")',got)
        self.assertIn('if(qsb_ssl_checked(BN_copy(x,y), "BN_copy"))',got)

    def test_failure_before_next_operation_and_pointer_identity(self):
        operations,sites=checked_openssl('int *x=BN_new(); if(x!=&value)return 9; BN_set_word(x,3); puts("finished");')
        code='''#include "pin_contract.h"
static int fault=0,step=0,value=0;
static int *BN_new(){++step;puts("allocate");return fault==step?NULL:&value;}
static int BN_set_word(int*x,int n){++step;puts("set");if(fault==step)return 0;*x=n;return 1;}
int main(int argc,char**argv){fault=atoi(argv[1]);
'''+operations+'}\n'
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'test.cpp').write_text(code)
            subprocess.run(['c++','-I',str(Path(__file__).parent),str(p/'test.cpp'),'-o',str(p/'test')],check=True,capture_output=True)
            for fault,want in [(0,['allocate','set','finished']),(1,['allocate']),(2,['allocate','set'])]:
                out=subprocess.run([str(p/'test'),str(fault)],capture_output=True,text=True)
                self.assertEqual(out.returncode,2 if fault else 0)
                self.assertEqual(out.stdout.splitlines(),want)

if __name__=='__main__':unittest.main()
