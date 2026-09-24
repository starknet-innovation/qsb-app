"""Offline image checks. No provider, transaction fixture, GPU allocation or range credit."""
import base64,hashlib,json,subprocess,sys
image=sys.argv[1]
def invoke(event,code=0):
 p=subprocess.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,nodev','-i',image],input=json.dumps(event),capture_output=True,text=True,timeout=60)
 assert p.returncode==code,(p.returncode,p.stderr[-1000:],p.stdout[-1000:]);return json.loads(p.stdout)
d=invoke({'action':'describe'})['result'];h=d['runtimeHash'];assert d['status']=='HOLD'
bad=invoke({'action':'compute','runtimeHash':'0'*64,'request':{}},2);assert bad['ok'] is False
r=subprocess.run(['docker','run','--rm','--network','none','--read-only','--entrypoint','cat',image,'/opt/qsb-validation/candidate/release.json'],capture_output=True,text=True,check=True);release=json.loads(r.stdout)
raw=b'\x00'*256
request={'protocol':'qsb-config-a-v1','stage':'round1','parameterBase64':base64.b64encode(raw).decode(),'parameterSha256':hashlib.sha256(raw).hexdigest(),'sequence':2147483648,'locktime':500000000,'attempt':0,'manifestHash':'a'*64,'kernelCommit':release['baseKernelCommit'],'searchVersion':'ranked-v2','solverId':release['id'],'solverReleaseHash':d['binding']['files']['candidate/release.json']}
negative=invoke({'action':'compute','runtimeHash':h,'request':request})
assert negative['result']['output']['status']=='failed' and negative['result']['output']['checkpoint']!='range-complete'
request['solverReleaseHash']='0'*64
assert invoke({'action':'compute','runtimeHash':h,'request':request},2)['ok'] is False
print(json.dumps({'checks':4,'describe':True,'wrongRuntimeRejected':True,'wrongSolverRejected':True,'realBinaryWithoutGpuFailsClosed':True,'gpuSuccess':False,'status':'HOLD'}))
