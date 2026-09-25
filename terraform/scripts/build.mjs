#!/usr/bin/env node
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
const network = process.argv.find(x=>x.startsWith('--network='))?.split('=')[1];
if (network !== 'mainnet' && network !== 'testnet4') throw Error('Set --network=mainnet or --network=testnet4');
const commit = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const clean = !execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();
if (!clean && !process.argv.includes('--allow-dirty')) throw Error('Commit changes first; --allow-dirty is for local validation only and cannot pass the Terraform release gate.');
const model = readFileSync('src/lib/model.ts','utf8');
if (!/mainnetEnabled:\s*false/.test(model)) throw Error('This deployment package only supports mainnet-disabled source');
// These are the reviewed local preparation/build tools, never downloaded setup scripts.
execFileSync('npm',['run','vendor'],{stdio:'inherit'});
execFileSync('npm',['run','build'],{stdio:'inherit',env:{...process.env,VITE_QSB_NETWORK:network,QSB_NETWORK:network}});
const out = path.join(root,'terraform/.build');
rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
cpSync('dist',path.join(out,'frontend'),{recursive:true});
for (const [name,entry] of [['api','server/lambda.ts'],['coordinator','server/coordinator.ts']]) {
  mkdirSync(path.join(out,name));
  await build({entryPoints:[entry],outfile:path.join(out,name,'index.js'),bundle:true,platform:'node',target:'node22',format:'cjs',minify:true,define:{'import.meta.env':'undefined'},logLevel:'warning'});
}
execFileSync('node',[path.join(root,'consensus/build.mjs'),path.join(out,'api/native')],{stdio:'inherit'});
execFileSync('node',[path.join(root,'consensus/test-linux.mjs'),path.join(out,'api/native')],{stdio:'inherit'});
mkdirSync(path.join(out,'reference'));
for (const name of readdirSync('worker/cpu').filter(n=>n.endsWith('.py') || n==='LICENSE')) cpSync(path.join('worker/cpu',name),path.join(out,'reference',name));
execFileSync('python3',[path.join(root,'terraform/scripts/zip.py'),out],{stdio:'inherit'});
const walk=(dir,prefix='')=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);
const frontendFiles=walk(path.join(out,'frontend')).sort();
const files={};
for(const n of ['api.zip','coordinator.zip','reference.zip',...frontendFiles.map(n=>'frontend/'+n)]) files[n]=createHash('sha256').update(readFileSync(path.join(out,n))).digest('hex');
const after=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();
// Dependency preparation must not silently modify tracked source.
if(clean && after) throw Error('Build changed tracked source; review and rebuild from a clean commit');
writeFileSync(path.join(out,'manifest.json'),JSON.stringify({commit,clean,network,transactionsEnabled:false,files,frontend_files:frontendFiles},null,2)+'\n');
console.log(`Prepared ${network} artifacts for ${commit}; clean=${clean}. No cloud changes.`);
