"""Isolated subset adapter. Not registered with the production coordinator."""
import pathlib
from release_guard import check_request
import range_adapter
ROOT=pathlib.Path(__file__).resolve().parent

def handler(event):
    data=event['input'];descriptor,release_hash=check_request(data,ROOT)
    clean={k:v for k,v in data.items() if k not in ('solverId','solverReleaseHash')}
    # Existing public-only validation, bounded process and failure-credit logic.
    output=range_adapter.handler({'input':clean})
    output.update(solverId=descriptor['id'],solverReleaseHash=release_hash,binarySha256=descriptor['files']['subset'])
    return output
