import importlib.util
import json
import marshal
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import test_pin_reference

class PinnedLoader(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        test_pin_reference.ReferenceBinding.setUpClass()
        cls.context=test_pin_reference.ReferenceBinding.ctx

    def run_child(self,root):
        return subprocess.run([sys.executable,'-I',str(root/'scripts/yukon/pin_reference.py'),'child'],
          input=json.dumps({**self.context,'stage':'pinning','action':'export'}),capture_output=True,text=True)

    def copy_runtime(self,root):
        source=Path(__file__).resolve().parents[2]
        dest=root/'scripts/yukon';dest.mkdir(parents=True)
        for name in ('pin_reference.py','pin_reference_lock.json'):
            shutil.copyfile(source/'scripts/yukon'/name,dest/name)
        cpu=root/'worker/cpu';cpu.mkdir(parents=True)
        for name in json.loads((dest/'pin_reference_lock.json').read_text()):
            shutil.copyfile(source/'worker/cpu'/name,cpu/name)
        return cpu

    def test_forged_valid_timestamp_bytecode_cannot_replace_pinned_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);cpu=self.copy_runtime(root);source=cpu/'handler.py'
            st=source.stat();cached=Path(importlib.util.cache_from_source(str(source)));cached.parent.mkdir()
            code=compile("def handler(event): return {'forgedCache': True}",str(source),'exec')
            cached.write_bytes(importlib.util.MAGIC_NUMBER+struct.pack('<III',0,int(st.st_mtime),st.st_size)+marshal.dumps(code))
            # Establish that the forged cache is usable by an ordinary isolated import.
            probe=subprocess.run([sys.executable,'-I','-c',
              'import sys;sys.path.insert(0,sys.argv[1]);import handler;print(handler.handler({}))',str(cpu)],capture_output=True,text=True)
            self.assertEqual(probe.returncode,0);self.assertIn('forgedCache',probe.stdout)
            actual=self.run_child(root)
            self.assertEqual(actual.returncode,0,actual.stderr)
            self.assertEqual(set(json.loads(actual.stdout)),{'parameterBase64','parameterSha256'})

    def test_changed_source_and_symlink_rejected(self):
        for mode in ('changed','symlink'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);cpu=self.copy_runtime(root);source=cpu/'handler.py'
                if mode=='changed':source.write_text(source.read_text()+'\n# changed\n')
                else:
                    other=root/'same-bytes.py';source.rename(other);source.symlink_to(other)
                actual=self.run_child(root)
                self.assertNotEqual(actual.returncode,0)
                self.assertIn('Pinned CPU source mismatch',actual.stderr)
