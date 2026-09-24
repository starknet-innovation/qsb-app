import hashlib,json,sys
from pathlib import Path
from verify import execute
from ownership import enc
root=Path(sys.argv[1]);config=json.loads((root/'config.json').read_bytes());census=json.loads((root/'census.json').read_bytes())
if census['configSha256']!=hashlib.sha256(enc(config)).hexdigest() or census['ledger']!=str(root/'ledger'):raise ValueError('Census mismatch')
for name,digest in census['sources'].items():
 if hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()!=digest:raise ValueError('Enrolled source mismatch')
execute(config['event'],root/'ledger',config['holdAfterStart'])
