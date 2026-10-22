// Run positive corrected-release plans without enrolling a fake release in source.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(new URL('../..', import.meta.url).pathname);
const temp = mkdtempSync(join(tmpdir(), 'qsb-terraform-contract-'));
try {
  for (const relative of ['terraform/gpu', 'terraform/.build', 'server/gpu-spend.json', 'server/aws-batch-command.json', 'src/lib/releases', 'src/lib/script-version.ts']) {
    const dest = join(temp, relative); mkdirSync(resolve(dest, '..'), { recursive: true });
    cpSync(join(root, relative), dest, {recursive: true});
  }
  const descriptor = JSON.parse(readFileSync(join(temp, 'terraform/.build/test-only-descriptor.json')));
  writeFileSync(join(temp, 'src/lib/releases/test-only.json'), JSON.stringify(descriptor));
  for(const item of JSON.parse(readFileSync(join(temp,'terraform/.build/test-only-incompatible-descriptors.json'))))
    writeFileSync(join(temp,'src/lib/releases',item.id+'.json'),JSON.stringify(item));
  execFileSync('terraform', ['-chdir='+join(temp,'terraform/gpu'), 'init', '-backend=false', '-input=false', '-lockfile=readonly'], {stdio:'inherit'});
  execFileSync('terraform', ['-chdir='+join(temp,'terraform/gpu'), 'test'], {stdio:'inherit'});
} finally { rmSync(temp, {recursive:true,force:true}); }
