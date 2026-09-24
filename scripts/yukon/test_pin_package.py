import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import package_pin_runtime as package

class Package(unittest.TestCase):
    def test_only_explicit_public_closure_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);binary=root/'binary';binary.write_bytes(b'unit test binary, not CUDA')
            with patch.object(package,'FROZEN_BINARY',hashlib.sha256(binary.read_bytes()).hexdigest()):
                out=root/'package';m=package.package(binary,out)
                self.assertEqual(m['files']['bin/pinning'],hashlib.sha256(binary.read_bytes()).hexdigest())
                self.assertEqual(len(m['files']),11)
                self.assertFalse(m['dispatchAuthorized']);self.assertIsNone(m['imageManifestDigest'])
                self.assertEqual(m['releaseStatus'],'HOLD')
                self.assertEqual(set(p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file()),set(m['files'])|{'Dockerfile','runtime-manifest.json','pin_queue.py','requirements.lock','queue-binding.json'})
                with self.assertRaises(ValueError):package.package(binary,out)
    def test_wrong_binary_and_symlink_rejected_before_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);binary=root/'wrong';binary.write_bytes(b'not enrolled')
            with self.assertRaises(ValueError):package.package(binary,root/'out')
            self.assertFalse((root/'out').exists())
            link=root/'link';link.symlink_to(binary)
            with patch.object(package,'FROZEN_BINARY',hashlib.sha256(binary.read_bytes()).hexdigest()):
                with self.assertRaises(ValueError):package.package(link,root/'out')
