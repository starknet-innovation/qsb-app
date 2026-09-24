import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(readFileSync(join(root,'source-manifest.json'),'utf8'));
for(const f of manifest.files){const actual=createHash('sha256').update(readFileSync(join(root,f.path))).digest('hex');if(actual!==f.sha256)throw Error('Archive source changed: '+f.path);}
const result=await build({absWorkingDir:root,entryPoints:['entry.ts'],outfile:join(root,'dist/service.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',packages:'external',sourcemap:true,metafile:true,define:{'import.meta.env':'undefined'}});
writeFileSync(join(root,'build-metafile.json'),JSON.stringify(result.metafile,null,2)+'\n');
