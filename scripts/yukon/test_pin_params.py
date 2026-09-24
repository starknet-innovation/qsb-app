import struct
import subprocess
import tempfile
import unittest
from pathlib import Path


def params(sl=75,total=9995,seq=31,lt=67):
    return struct.pack('>8I',*range(1,9))+struct.pack('<I',sl)+bytes(range(sl))+struct.pack('<III',total,seq,lt)+bytes(range(96))


class ParamsTests(unittest.TestCase):
    def test_bounded_parser_rejects_malformed_records(self):
        code=r'''#include "pin_contract.h"
#include "pin_params.h"
int main(int argc,char**argv) {
    pinning2_params_t p;
    if(load_pinning2(argv[1],&p)!=0) return 2;
    printf("%u %u %u %u %u %u %u %u\n",p.midstate[0],p.midstate[7],p.suffix_len,p.total_preimage_len,p.seq_offset,p.lt_offset,p.suffix[p.suffix_len-1],p.u2r_y[31]);
    free(p.suffix);
}
'''
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'test.cpp').write_text(code)
            subprocess.run(['c++','-I',str(Path(__file__).parent),str(p/'test.cpp'),'-o',str(p/'test')],check=True,capture_output=True)
            valid=params()
            cases=[valid[:i] for i in range(len(valid))]
            cases += [valid+b'x',valid+b'x'*1000, valid[:32]+struct.pack('<I',0xffffffff)+valid[36:]]
            cases += [params(total=9994),params(total=10),params(seq=0xffffffff),params(lt=0xffffffff),params(seq=68),params(lt=68),params(sl=120,total=10104)]
            for i,raw in enumerate(cases):
                (p/'input').write_bytes(raw)
                out=subprocess.run([str(p/'test'),str(p/'input')],capture_output=True)
                self.assertEqual(out.returncode,2,i);self.assertEqual(out.stdout,b'')
            for raw,want in [(valid,'1 8 75 9995 31 67 74 95\n'),(params(119,183,0,111),'1 8 119 183 0 111 118 95\n'),(params(12,12,0,4),'1 8 12 12 0 4 11 95\n')]:
                (p/'input').write_bytes(raw)
                out=subprocess.run([str(p/'test'),str(p/'input')],capture_output=True,text=True,check=True)
                self.assertEqual(out.stdout,want)
            out=subprocess.run([str(p/'test'),str(p/'missing')],capture_output=True)
            self.assertEqual(out.returncode,2)

if __name__=='__main__':unittest.main()
