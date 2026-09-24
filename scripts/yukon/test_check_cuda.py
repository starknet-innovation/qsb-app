import subprocess
import tempfile
from pathlib import Path
import unittest
from check_cuda import checked_cuda

class CudaCheckTests(unittest.TestCase):
    def test_preserve_checked_expressions_and_literals(self):
        source='''// cudaMalloc(x);
const char *s="cudaMalloc(x);";
cudaError_t err =
 cudaMalloc(x);
if (cudaMemcpy(x) != cudaSuccess) return 1;
err = cudaMemset(x);
'''
        got,calls=checked_cuda(source)
        self.assertEqual(got,source);self.assertEqual(calls,[])

    def test_wrap_each_statement_once_and_stop_on_error(self):
        source='''cudaMalloc(1); cudaMemcpy(2);
#ifdef TEST
cudaMemset(3);
#endif
'''
        got,calls=checked_cuda(source)
        self.assertEqual(calls,['cudaMalloc(1)','cudaMemcpy(2)','cudaMemset(3)'])
        self.assertEqual(got.count('QSB_CUDA('),3)
        code='''#include "pin_contract.h"
static int step=0, fault=0;
static int call(int n){ ++step; printf("call=%d\\n",n); return step==fault?7:0; }
#define cudaMalloc call
#define cudaMemcpy call
#define cudaMemset call
#define cudaSuccess 0
#define TEST
#define QSB_CUDA(call) qsb_require_host((call)==cudaSuccess,#call)
int main(int argc,char**argv){fault=atoi(argv[1]);
'''+got+'''puts("finished");}
'''
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'test.cpp').write_text(code)
            subprocess.run(['c++','-I',str(Path(__file__).parent),str(p/'test.cpp'),'-o',str(p/'test')],check=True,capture_output=True)
            for n in range(4):
                out=subprocess.run([str(p/'test'),str(n)],capture_output=True,text=True)
                self.assertEqual(out.returncode,2 if n else 0)
                self.assertEqual(out.stdout.splitlines(),[f'call={i}' for i in range(1,(n or 3)+1)]+([] if n else ['finished']))

if __name__=='__main__':unittest.main()
