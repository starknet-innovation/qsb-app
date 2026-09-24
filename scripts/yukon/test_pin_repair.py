"""Host regression against the application's independent Python DER reference."""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from adapt_pin import adapt, FLAGS
from validate import ROOT, function


def reference():
    tree=ast.parse((ROOT/'worker/cpu/gpu_emulator.py').read_text())
    node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='is_valid_der')
    ns={};exec(compile(ast.Module(body=[node],type_ignores=[]),'reference','exec'),ns)
    return ns['is_valid_der']


def vectors():
    v=bytes([0x30,29,2,12])+b'\x11'*12+bytes([2,13])+b'\x22'*13+b'\x01'
    out=[bytes(32),v]
    for pos in range(32):
        for val in range(256):
            b=bytearray(v);b[pos]=val;out.append(bytes(b))
    for r in range(1,25):
        s=25-r
        for sighash in (0,1,0x81,0xff):
            out.append(bytes([0x30,29,2,r])+b'\x11'*r+bytes([2,s])+b'\x22'*s+bytes([sighash]))
    out += [hashlib.sha256(str(i).encode()).digest() for i in range(2048)]
    return out


def probe(source):
    vals=vectors();oracle=reference()
    code='#include <stdint.h>\n#include <stdio.h>\n#include "pin_contract.h"\n#define __device__\n#define __forceinline__\n'
    code+='\n'.join(function(source,n) for n in ['gpu_bench_valid','gpu_bench_valid_words'])
    code+='\nint main(){uint8_t d[32];while(fread(d,1,32,stdin)==32){uint32_t w[8];for(int i=0;i<8;i++)w[i]=((uint32_t)d[4*i]<<24)|((uint32_t)d[4*i+1]<<16)|((uint32_t)d[4*i+2]<<8)|d[4*i+3];printf("%d %d %d\\n",qsb_der32(d),gpu_bench_valid(d),gpu_bench_valid_words(w));}return 0;}'
    with tempfile.TemporaryDirectory() as tmp:
        p=Path(tmp);(p/'test.cpp').write_text(code)
        subprocess.run(['c++','-std=c++17','-O2','-I',str(Path(__file__).parent),str(p/'test.cpp'),'-o',str(p/'test')],capture_output=True,check=True)
        result=subprocess.run([str(p/'test')],input=b''.join(vals),capture_output=True,check=True).stdout.decode().splitlines()
    expected=[' '.join([str(int(oracle(v)))]*3) for v in vals]
    if result!=expected:raise AssertionError('DER differential mismatch')
    return {'vectors':len(vals),'matchingPredicateOutputs':len(vals)*3,'reference':'worker/cpu/gpu_emulator.py:is_valid_der','gpuExecution':False}


class RepairTests(unittest.TestCase):
    def test_changed_patch_context_rejected(self):
        with self.assertRaises(ValueError):adapt('int main(){}')

    def test_capacity_fail_closed(self):
        code='#include "pin_contract.h"\nint main(int argc,char**argv){uint32_t v[]={0,1,63,64,65,1024,0xffffffff};for(int i=0;i<7;i++)printf("%d\\n",qsb_require_hit_capacity(v[i]));}'
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'test.cpp').write_text(code)
            subprocess.run(['c++','-I',str(Path(__file__).parent),str(p/'test.cpp'),'-o',str(p/'test')],check=True,capture_output=True)
            out=subprocess.run([str(p/'test')],capture_output=True,text=True,check=True)
        self.assertEqual(out.stdout.splitlines(),['1','1','1','1','0','0','0'])
        self.assertEqual(out.stderr.count('QSB_RANGE_INCOMPLETE'),3)


if __name__=='__main__':
    import sys
    if len(sys.argv)==2:
        source=Path(sys.argv[1]).read_text()
        assert 'ok = qsb_der32(hh);' in source
        assert 'qsb_host_zeros(hh) >=' not in source
        assert 'if (count > 64) count = 64;' not in source
        assert '(h_hit > 64) ? 64' not in source
        assert source.count('if (!qsb_require_hit_capacity(')==4
        for name in FLAGS:assert f'#define {name} 0' in source
        print(json.dumps(probe(source),indent=2))
    else: unittest.main()
