import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from pin_runtime import sha
import test_pin_runtime

class RuntimeRunner(unittest.TestCase):
    def test_failure_preserves_partial_without_success_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);binary=p/'solver';binary.write_text('#!/bin/sh\nexit 2\n');binary.chmod(0o700)
            h=sha(binary.read_bytes());request=test_pin_runtime.PinRuntime().request(h)
            (p/'requests.json').write_text(json.dumps([request]))
            r=subprocess.run([sys.executable,str(Path(__file__).with_name('check_pin_runtime_gpu.py')),'--requests',str(p/'requests.json'),'--binary',str(binary),'--sha256',h,'--out',str(p/'results.json')],capture_output=True,text=True)
            self.assertNotEqual(r.returncode,0);self.assertFalse((p/'results.json').exists())
            partial=json.loads((p/'results.partial.json').read_text())
            self.assertFalse(partial['complete']);self.assertEqual(partial['runs'][0]['output']['status'],'failed')
            self.assertFalse(partial['runs'][0]['output']['rangeCreditEligible'])
