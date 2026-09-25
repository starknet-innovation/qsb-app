"""Run six fixed-size subset probes and an independent SHA audit. No network."""
import hashlib,json,pathlib,re,subprocess,sys,time
ROOT=pathlib.Path('/opt/qsb-benchmark');OUT=pathlib.Path('/results');COUNT=2**24
sys.path.insert(0,'/src/worker/cpu');from handler import handler

def main():
    OUT.mkdir(exist_ok=True)
    receipt=json.loads((ROOT/'build-receipt.json').read_text())
    for name,digest in receipt['binarySha256'].items():
        assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest
    fixture=json.loads((ROOT/'fixture/fixture.json').read_text())
    for name,digest in fixture['files'].items():
        assert hashlib.sha256((ROOT/'fixture'/name).read_bytes()).hexdigest()==digest
    event=json.loads((ROOT/'fixture/event.json').read_text())
    report={'status':'running','scope':'synthetic subset components only; not full search or withdrawal','build':receipt,'fixture':fixture,'runs':[]}
    report['gpu']=subprocess.check_output(['nvidia-smi','--query-gpu=name,driver_version,memory.total','--format=csv,noheader'],text=True,timeout=10).strip()
    audit=subprocess.run([str(ROOT/'first-stage-audit')],capture_output=True,text=True,timeout=120,check=True)
    report['cpuComparison']=json.loads(audit.stdout.strip().splitlines()[-1]);assert report['cpuComparison']['errors']==0
    for stage in ('round1','round2'):
        for repetition in range(3):
            work=OUT/f'{stage}-{repetition}';work.mkdir()
            command=[str(ROOT/'subset'),str(ROOT/'fixture'/('digest_r'+stage[-1]+'.bin')),'0','2147483648','500000000','1','0','single_hash','rank_start=0',f'rank_count={COUNT}']
            start=time.monotonic()
            with (work/'compute.log').open('w') as log:
                subprocess.run(command,cwd=work,stdout=log,stderr=subprocess.STDOUT,timeout=180,check=True)
            elapsed=time.monotonic()-start
            text='\n'.join(p.read_text() for p in work.rglob('*') if p.is_file())
            completed=re.findall(r'STATUS=EXHAUSTED[^\n]*total_attempts=(\d+)',text)
            assert completed and int(completed[-1])==COUNT,'Range did not complete exactly'
            checked=0
            for p in (work/'results').glob('*hit*.txt'):
                for hit in re.split(r'(?=^indices=)',p.read_text(),flags=re.M):
                    if not hit.strip():continue
                    result=handler({**event,'action':'verify','stage':stage,'candidates':[hit]})
                    assert result.get('valid') or result.get('derOnly'),'CPU rejected GPU candidate'
                    checked+=1
            report['runs'].append({'stage':stage,'repetition':repetition,'ranks':COUNT,'elapsedIncludingStartupSeconds':elapsed,'ranksPerWallSecond':COUNT/elapsed,'cpuCheckedCandidates':checked})
            (OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    report['status']='completed'
    (OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
if __name__=='__main__':main()
