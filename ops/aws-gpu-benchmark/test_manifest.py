import hashlib
import io
import tarfile
import unittest
from manifest import verified_files

COMMIT = 'a' * 40
NAME = 'research/optimized-subset/subset/subset.cu'


def archive(members=None):
    data = b'public test source'
    members = members or [(NAME, data, tarfile.REGTYPE)]
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
        for name, content, kind in members:
            item = tarfile.TarInfo('qsb-solver-' + COMMIT + '/' + name)
            item.type = kind
            item.size = len(content)
            tar.addfile(item, io.BytesIO(content))
    blob = buffer.getvalue()
    pin = dict(repository='starknet-innovation/qsb-solver', commit=COMMIT,
               archiveSha256=hashlib.sha256(blob).hexdigest(),
               files={NAME: hashlib.sha256(data).hexdigest()})
    return blob, pin


class ManifestTests(unittest.TestCase):
    def test_verified_source_only(self):
        blob, pin = archive()
        self.assertEqual(verified_files(blob, pin), {NAME: b'public test source'})

    def test_archive_or_file_tamper_rejected(self):
        blob, pin = archive()
        with self.assertRaisesRegex(ValueError, 'archive hash'):
            verified_files(blob + b'corruption', pin)
        pin['files'][NAME] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'source hash'):
            verified_files(blob, pin)

    def test_missing_extra_duplicate_and_symlink_fail(self):
        cases = [[(NAME + '.other', b'extra', tarfile.REGTYPE)],
                 [(NAME, b'public test source', tarfile.REGTYPE)] * 2,
                 [(NAME, b'public test source', tarfile.SYMTYPE)],
                 [(NAME.replace('subset.cu', '../escape'), b'x', tarfile.REGTYPE)]]
        for members in cases:
            blob, pin = archive(members)
            with self.subTest(members=members), self.assertRaises(ValueError):
                verified_files(blob, pin)
        blob, pin = archive()
        pin['files']['worker/optimized/source-lock.json'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            verified_files(blob, pin)

    def test_repository_and_commit_cannot_float(self):
        blob, pin = archive()
        pin['commit'] = 'main'
        with self.assertRaisesRegex(ValueError, 'provenance'):
            verified_files(blob, pin)
