#!/usr/bin/env python3
"""Read-only deployment diagnostics, not launch or release authorization."""
import json, os, platform, shutil, subprocess
from pathlib import Path

def checks(config):
    return {
        'linux_x86_64': platform.system() == 'Linux' and platform.machine() == 'x86_64',
        'execution_disabled': config.get('executionEnabled') is False,
        'evidence_mounted': os.path.ismount('/evidence'),
        'node_present': Path('/usr/local/bin/node').is_file(),
        'python_present': Path('/usr/local/bin/python').is_file(),
        'docker_present': shutil.which('docker') is not None,
        'sealed_distribution_present': Path('/source/manifest.json').is_file(),
        'complete_dispatcher_present': Path('/opt/qsb/bin/dispatch-service').is_file(),
        'runtime_identity_available': Path('/proc/self/stat').is_file(),
    }

if __name__ == '__main__':
    result = checks(json.loads(Path('/etc/qsb/host.json').read_text()))
    print(json.dumps({'checks': result, 'launchAuthorized': False}, indent=2))
    raise SystemExit(0 if all(result.values()) else 2)
