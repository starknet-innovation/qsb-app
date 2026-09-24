import unittest
from native_pin import check_trace, expected

class NativeProtocolTests(unittest.TestCase):
    def test_trace_requires_exact_coverage(self):
        case={'expected':{'2147483648:500000000:0':'a'*64,'2147483648:500000000:1':'b'*64}}
        lines=[f'QSB_TRACE seq=2147483648 lt=500000000 ri={i} hash={h*64}' for i,h in [(0,'a'),(1,'b')]]
        self.assertEqual(check_trace('\n'.join(reversed(lines)),case),2)
        for bad in [lines[:1],lines+[lines[0]],[lines[0],lines[1].replace('b'*64,'c'*64)],lines+['QSB_TRACE broken']]:
            with self.assertRaises(ValueError):check_trace('\n'.join(bad),case)

    def test_independent_reference_depends_on_sequence_and_locktime(self):
        suffix=bytes(8)+bytes([1,0,0,0])
        first=expected(suffix,2147483648,500000000)
        self.assertEqual(set(first),{0,1});self.assertNotEqual(first[0],first[1])
        self.assertNotEqual(first,expected(suffix,2147483649,500000000))
        self.assertNotEqual(first,expected(suffix,2147483648,500000001))

if __name__=='__main__':unittest.main()
