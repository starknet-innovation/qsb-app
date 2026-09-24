import {createHash,randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';import {readFileSync,mkdirSync,openSync,writeSync,fsyncSync,closeSync,realpathSync,lstatSync} from 'node:fs';import {join,dirname} from 'node:path';
export const RUNTIME='14ca2c729ecee121c715b7ff1acb9b8656b8650f8f4c02e3454c1067d22edeb9';
const SOURCE='/source/owned-runtime/cpu',h=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const canonical=(v:any):string=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
export type Census={register:(entry:any)=>Promise<void>;complete:(entry:any)=>Promise<void>};
function syncDir(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function save(path:string,value:any){const fd=openSync(path,'wx',0o600);try{writeSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}syncDir(dirname(path));}
/** Fixed Linux adapter. Caller supplies authoritative common-lifetime census, never commands or verifier source. */
export async function runOwnedCpu(input:any,census:Census){
 const verify=async(input:any)=>{
  const allowed={'pin-export-v4':'0ef53314fcf1e6307bd2249dfdb7da483ae9ae08855c36328fbeda51cda1fea0','pin-candidates-v5':RUNTIME,'pin-handoff-v5':RUNTIME,'subset-export-v5':RUNTIME,'subset-verify-v5':RUNTIME};
  if(process.platform!=='linux'||!input||Object.keys(input).sort().join(',')!=='operation,payload,scopeBinding'||!Object.hasOwn(allowed,input.operation)||!input.scopeBinding||Object.keys(input.scopeBinding).sort().join(',')!=='configHash,operationKey,runPk'||!/^SUPERVISION#supervised-[a-z0-9-]+$/.test(input.scopeBinding.runPk)||!/^OPERATION#[a-zA-Z0-9:_-]+$/.test(input.scopeBinding.operationKey)||!/^[a-f0-9]{64}$/.test(input.scopeBinding.configHash))throw Error('Exact fixed runtime/scope envelope required');
  const event=JSON.parse(JSON.stringify(input));if(Buffer.byteLength(JSON.stringify(event))>1000000)throw Error('Oversized runtime request');
  const runtimeHash=allowed[event.operation as keyof typeof allowed];
  const enrollment=JSON.parse(readFileSync(join(SOURCE,'enrollment.json'),'utf8'));for(const [n,want] of Object.entries(enrollment.sources)){const file=join(SOURCE,n);if(!/^[a-z_-]+\.py$/.test(n)||lstatSync(file).isSymbolicLink()||h(readFileSync(file))!==want)throw Error('Fixed source differs');}
  const id='runtime-cpu-'+randomUUID(),dir=join('/evidence/owned-cpu',id);if(realpathSync('/evidence')!=='/evidence')throw Error('Evidence root changed');mkdirSync('/evidence/owned-cpu',{recursive:true,mode:0o700});syncDir('/evidence');mkdirSync(dir,{mode:0o700});syncDir('/evidence/owned-cpu');syncDir('/evidence');const cfg={format:'qsb-owned-pin-supervisor-test-v1',lifetime:id,event,holdAfterStart:false};save(join(dir,'config.json'),cfg);
  const binding={operation:id,runtimeOperation:event.operation,scopeBinding:event.scopeBinding,directory:dir,ledger:join(dir,'ledger'),configHash:h(canonical(cfg)),inputHash:h(canonical(event)),sourceHash:h(readFileSync(join(SOURCE,'enrollment.json'))),supervisorHash:h(readFileSync(join(SOURCE,'supervisor.py'))),runtimeHash,callbackHash:h(readFileSync('/source/owned-runtime/runtime.cjs'))};
  await census.register(binding); // Must be durable before any Docker/process creation.
  const child=spawn('/usr/local/bin/python',[join(SOURCE,'owned_exec.py'),String(process.pid),'--','/usr/local/bin/python',join(SOURCE,'supervisor.py'),dir],{stdio:['ignore','ignore','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});let stderr='';child.stderr.on('data',b=>{if(stderr.length<4096)stderr+=b.toString().slice(0,4096-stderr.length);});
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  if(code!==0)throw Error('Owned CPU failed; census remains unresolved for authoritative cleanup review');
  const out=JSON.parse(readFileSync(join(dir,'verified-result.json'),'utf8')),cleanBytes=readFileSync(join(dir,'cleanup-receipt.json')),clean=JSON.parse(cleanBytes.toString()),daemon=JSON.parse(readFileSync(join(dir,'ledger/cleaned.json'),'utf8')),result=out.result;
  if(out.configSha256!==binding.configHash||out.cleanupSha256!==h(cleanBytes)||clean.sameNamespaceReaped!==true||clean.containerAbsent!==true||daemon.containerAbsent!==true||result.runtimeHash!==runtimeHash||result.format!=='qsb-owned-runtime-result-v1'||result.inputHash!==binding.inputHash||result.operation!==event.operation)throw Error('Owned runtime result/binding/cleanup mismatch');
  const receipt={...binding,cleanupHash:h(cleanBytes),resultHash:h(readFileSync(join(dir,'verified-result.json'))),containerAbsent:true,clientReaped:true,sealEligible:false};await census.complete(receipt);
  return {result:result.result,ownedVerification:receipt};
 };
 return verify(input);
}
