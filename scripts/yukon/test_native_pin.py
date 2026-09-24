import unittest
import hashlib
import struct
from test_pin_recovery import N
from sha_midstate import midstate
from native_pin import check_trace, expected

class NativeProtocolTests(unittest.TestCase):
    def test_midstate_export_matches_complete_sha(self):
        for message in [b'',b'abc',bytes(range(256))]:
            pad=message+b'\x80'
            pad+=bytes((56-len(pad)%64)%64)+struct.pack('>Q',len(message)*8)
            self.assertEqual(struct.pack('>8I',*midstate(pad)),hashlib.sha256(message).digest())
        with self.assertRaises(ValueError):midstate(b'x')

    def test_trace_requires_exact_coverage(self):
        case={'expected':{'2147483648:500000000:0':'a'*64,'2147483648:500000000:1':'b'*64}}
        lines=[f'QSB_TRACE seq=2147483648 lt=500000000 ri={i} hash={h*64}' for i,h in [(0,'a'),(1,'b')]]
        self.assertEqual(check_trace('\n'.join(reversed(lines)),case),2)
        for bad in [lines[:1],lines+[lines[0]],[lines[0],lines[1].replace('b'*64,'c'*64)],lines+['QSB_TRACE broken']]:
            with self.assertRaises(ValueError):check_trace('\n'.join(bad),case)

    def test_constructed_exception_keeps_doubling_and_infinity(self):
        seq=2147483660;lt=500000512;nri=7
        message=struct.pack('<III',seq,lt,1)
        z=int.from_bytes(hashlib.sha256(hashlib.sha256(message).digest()).digest(),'big')
        for sign,inf in [(1,1),(-1,0)]:
            got=expected(bytes(8)+struct.pack('<I',1),seq,lt,nri,(sign*z*nri)%N)
            self.assertEqual(got[inf],'infinity')
            self.assertEqual(len(got[1-inf]),64)
            line=f'QSB_TRACE seq={seq} lt={lt} ri={inf} hash=infinity'
            self.assertEqual(check_trace(line,{'expected':{f'{seq}:{lt}:{inf}':'infinity'}}),1)

    def test_independent_reference_depends_on_sequence_and_locktime(self):
        suffix=bytes(8)+bytes([1,0,0,0])
        first=expected(suffix,2147483648,500000000)
        self.assertEqual(set(first),{0,1});self.assertNotEqual(first[0],first[1])
        self.assertNotEqual(first,expected(suffix,2147483649,500000000))
        self.assertNotEqual(first,expected(suffix,2147483648,500000001))

if __name__=='__main__':unittest.main()
