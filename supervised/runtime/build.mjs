import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync,rmSync,cpSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url)), source=path.join(root,'source'), out=path.join(root,'dist');
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const walk=d=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]).sort();
const manifest=JSON.parse(readFileSync(path.join(root,'source-manifest.json'),'utf8'));
for(const f of manifest.files)if(sha(path.join(root,f.path))!==f.sha256)throw Error('Public runtime source changed: '+f.path);
const actual=['source','layout'].flatMap(d=>walk(path.join(root,d))).map(p=>path.relative(root,p)).sort();
if(JSON.stringify(actual)!==JSON.stringify(manifest.files.map(f=>f.path).sort()))throw Error('Unlisted runtime source');
rmSync(out,{recursive:true,force:true});cpSync(path.join(root,'layout'),out,{recursive:true});
const entries={
 'common-linux/controller.cjs':'work/yukon-operational-distribution-sealed-20260923/controller-entry.ts',
 'common-linux/retire-entry.cjs':'work/yukon-operational-distribution-sealed-20260923/retire-entry.ts',
 'validate.cjs':'work/yukon-operational-distribution-sealed-20260923/validate.ts',
 'owned-runtime/runtime.cjs':'work/yukon-owned-runtime-publicstate-20260923/runtime.ts',
};
const inputs=new Set();
for(const [dest,entry] of Object.entries(entries)){
 const result=await build({absWorkingDir:source,entryPoints:[entry],outfile:path.join(out,dest),bundle:true,platform:'node',target:'node22',format:'cjs',metafile:true,define:{'import.meta.url':'"file:///repo/work/yukon-pin-adapter-20260923/adapter.ts"','import.meta.env':'{}'},plugins:[{name:'fixed-drain',setup(b){b.onLoad({filter:/yukon-mainnet-cycling-runner-20260923\/drain.ts$/},a=>({contents:readFileSync(a.path,'utf8').replace("new URL('./drain.ts',import.meta.url)","__dirname+'/drain-source.ts'"),loader:'ts'}));}}]});
 for(const n of Object.keys(result.metafile.inputs)){
  if(n.startsWith('<'))continue;
  const p=path.resolve(source,n);
  if(!p.startsWith(source+path.sep)&&!p.startsWith(path.resolve(root,'../../node_modules')+path.sep))throw Error('Build escaped public source/dependency closure: '+n);
  inputs.add(n);
 }
}
const save=(name,v)=>{const p=path.join(out,name);mkdirSync(path.dirname(p),{recursive:true});writeFileSync(p,JSON.stringify(v,null,2)+'\n');};
const cpu=walk(path.join(out,'owned-runtime/cpu')).filter(p=>p.endsWith('.py'));
save('owned-runtime/cpu/enrollment.json',{sources:Object.fromEntries(cpu.map(p=>[path.basename(p),sha(p)]))});
save('common-linux/enrollment.json',{files:Object.fromEntries(['controller.cjs','retire-entry.cjs','supervisor.py','leader.py','owned_exec.py','adaptive.py'].map(n=>[n,sha(path.join(out,'common-linux',n))])),cpu:Object.fromEntries(['runtime.cjs','cpu/enrollment.json'].map(n=>[n,sha(path.join(out,'owned-runtime',n))]))});
save('manifest.json',{format:'qsb-operational-distribution-v1',status:'HOLD',executionEnabled:false,sourceManifestSha256:sha(path.join(root,'source-manifest.json')),packageLockSha256:sha(path.resolve(root,'../../package-lock.json')),files:Object.fromEntries(walk(out).map(p=>[path.relative(out,p),{sha256:sha(p)}])),paths:{package:'/source',common:'/source/common-linux',cpu:'/source/owned-runtime',evidence:'/evidence',archivedWorker:'/repo/outputs/qsb-vault/worker'},requirements:{platform:'Linux',providerCredential:'inherited FIFO fd3 only',externalAdmissionRequired:true,registryEnrollmentRequired:true}});
execFileSync('python3',[path.join(root,'pack.py'),out,path.join(root,'runtime.tar.gz')],{stdio:'inherit'});
console.log(JSON.stringify({manifestSha256:sha(path.join(out,'manifest.json')),archiveSha256:sha(path.join(root,'runtime.tar.gz')),sourceFiles:manifest.files.length,bundledInputs:inputs.size,status:'HOLD',historicalArchive:false}));
