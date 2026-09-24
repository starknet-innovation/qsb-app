import io
import tarfile
import unittest
from validate import sources, check_source_lock, sha, function


def archive(name, data=b'content', kind=tarfile.REGTYPE):
    buf=io.BytesIO()
    with tarfile.open(fileobj=buf,mode='w:gz') as tf:
        info=tarfile.TarInfo(name);info.type=kind
        if kind==tarfile.REGTYPE:info.size=len(data)
        tf.addfile(info,io.BytesIO(data) if kind==tarfile.REGTYPE else None)
    return buf.getvalue()


class IntakeTests(unittest.TestCase):
    def test_regular_source(self):
        self.assertEqual(sources(archive('root/candidates/pinning/pinning.cu')),{'pinning/pinning.cu':b'content'})
    def test_traversal_rejected(self):
        with self.assertRaises(ValueError):sources(archive('root/candidates/../../escape'))
    def test_absolute_rejected(self):
        with self.assertRaises(ValueError):sources(archive('/root/candidates/escape'))
    def test_symlink_rejected(self):
        with self.assertRaises(ValueError):sources(archive('root/candidates/pin',kind=tarfile.SYMTYPE))
    def test_device_rejected(self):
        with self.assertRaises(ValueError):sources(archive('root/candidates/pin',kind=tarfile.CHRTYPE))
    def test_lock_rejects_changed_source(self):
        with self.assertRaises(ValueError):check_source_lock({'pin.cu':b'changed'},{'sourceFiles':{'pin.cu':sha(b'original')}})
    def test_archived_source_not_in_active_lock(self):
        check_source_lock({'pin.cu':b'original','research/old.cu':b'unrelated'},{'sourceFiles':{'pin.cu':sha(b'original')}})
    def test_missing_source_rejected(self):
        with self.assertRaises(ValueError):check_source_lock({}, {'sourceFiles':{'pin.cu':sha(b'original')}})
    def test_predicate_signature_change_rejected(self):
        with self.assertRaises(ValueError):function('int other(){return 0;}','gpu_bench_valid')
    def test_embedded_unexpected_io_rejected(self):
        with self.assertRaises(ValueError):function('__device__ int gate(){fopen("x","w");return 0;}','gate')

if __name__=='__main__':unittest.main()
