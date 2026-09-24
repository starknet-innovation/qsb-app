"""One-request isolated validation runtime. No submission, storage or signing."""
import hashlib,json,pathlib,sys,math,contextlib,io
ROOT=pathlib.Path(__file__).resolve().parent

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def bindings():
    raw=(ROOT/'runtime-binding.json').read_bytes();d=json.loads(raw)
    for name,want in d['files'].items():
        p=ROOT/name
        if p.is_symlink() or '..' in pathlib.Path(name).parts or pathlib.Path(name).is_absolute() or sha(p)!=want:raise ValueError('Runtime artifact mismatch')
    return d,hashlib.sha256(raw).hexdigest()
def reference(event):
    sys.path.insert(0,str(ROOT/'reference'))
    import handler
    return handler.handler(event)
def rank(indices):
    if len(indices)!=9 or len(set(indices))!=9 or any(type(x)!=int or not 0<=x<150 for x in indices):raise ValueError('Invalid verified indices')
    c=sorted(149-x for x in indices);p=-1;r=0
    for i,v in enumerate(c):
        for j in range(p+1,v):r+=math.comb(149-j,8-i)
        p=v
    return r

def handle(e):
    d,h=bindings()
    if e=={'action':'describe'}:return {'runtimeHash':h,'binding':d,'status':'HOLD'}
    allowed={'action','runtimeHash','context','request','output'}
    if set(e)-allowed or e.get('runtimeHash')!=h:raise ValueError('Runtime pin mismatch or unknown fields')
    sys.path.insert(0,str(ROOT/'candidate'))
    import candidate_handler,range_adapter
    from release_guard import check_request,check_response
    from search_ranges import work_range
    action=e['action']
    if action=='compute':
        if set(e)!={'action','runtimeHash','request'}:raise ValueError('Unexpected compute fields')
        return {'runtimeHash':h,'output':candidate_handler.handler({'input':e['request']})}
    if action not in ('export','verify'):raise ValueError('Unsupported action')
    ctx=e['context'];req=e['request']
    if set(ctx)!={'publicStateJson','manifest','stage','sequence','locktime'}:raise ValueError('Unexpected public context')
    check_request(req,ROOT/'candidate')
    for k in ['stage','sequence','locktime']:
        if type(ctx[k])!=type(req.get(k)) or ctx[k]!=req[k]:raise ValueError('Parameter context mismatch')
    exported=reference(dict(ctx,action='export'))
    if action=='export':
        if set(e)!={'action','runtimeHash','context','request'}:raise ValueError('Unexpected export fields')
        # Export returns public bytes; caller must freeze them before paid work.
        return {'runtimeHash':h,**exported}
    range_adapter.validate_request({k:v for k,v in req.items() if k not in ('solverId','solverReleaseHash')})
    if any(req[k]!=exported[k] for k in ['parameterBase64','parameterSha256']):raise ValueError('Reference parameter mismatch')
    envelope=e['output']
    if set(envelope)!={'runtimeHash','output'} or envelope['runtimeHash']!=h:raise ValueError('Result runtime mismatch')
    unit=work_range(req['stage'],req['attempt'])
    records=check_response(envelope['output'],req,ROOT/'candidate',unit)
    verdict=reference(dict(ctx,action='verify',candidates=records)) if records else {'valid':False}
    if records and verdict.get('valid') is not True and verdict.get('derOnly') is not True:raise ValueError('Candidate needs independent review')
    if verdict.get('valid') is True:
        n=rank(verdict['indices'])
        if not int(unit['start'])<=n<int(unit['start'])+unit['count']:raise ValueError('Verified candidate outside requested range')
    return {'runtimeHash':h,'referenceChecked':True,'verdict':verdict,'eligibleForRangeCredit':verdict.get('valid') is not True,'decision':'candidate_verified' if verdict.get('valid') is True else 'range_complete','workRange':unit}

if __name__=='__main__':
    try:
        raw=sys.stdin.buffer.read(2000001)
        if len(raw)>2000000:raise ValueError('Request too large')
        # Do not let imported reference diagnostics pollute the JSON transport.
        with contextlib.redirect_stdout(io.StringIO()):result=handle(json.loads(raw))
        print(json.dumps({'ok':True,'result':result}))
    except Exception as error:
        print(json.dumps({'ok':False,'error':type(error).__name__+': '+str(error)}));sys.exit(2)
