// Mock-plan fixtures derived from the real build and enrolled descriptor.
// These are test inputs, never attestations or deployment manifests.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildIdentities } from '../../server/build-identities.ts';
const root = new URL('../.build/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const save = (name, value) => writeFileSync(new URL(name, root), JSON.stringify(value, null, 2) + '\n');
const build = read('manifest.json');
const descriptor = JSON.parse(readFileSync(new URL('../../src/lib/releases/qsb-solver-aws-v0-1-0.json', import.meta.url), 'utf8'));
const badReference = structuredClone(build);
badReference.identities.reference.sha256 = '0'.repeat(64);
save('test-bad-reference.json', badReference);
const gpu = structuredClone(build);
gpu.testFixtureOnly = 'Mock plan input; not deployment evidence';
gpu.identities = buildIdentities(descriptor.id, build.commit, build.files['reference.zip']);
save('test-gpu-valid.json', gpu);
for (const [name, mutate] of Object.entries({
  'unknown-id': x => { x.identities.solver.id = 'not-enrolled'; },
  'historical-schema': x => { const old = JSON.parse(readFileSync(new URL('../../src/lib/releases/qsb-solver-v0-1-0.json', import.meta.url), 'utf8')); x.identities.solver = { id: old.id, image: old.image, solverCommit: old.solverCommit };  },
  'wrong-image': x => { x.identities.solver.image = 'ghcr.io/starknet-innovation/qsb-solver@sha256:' + '1'.repeat(64); },
  'wrong-commit': x => { x.identities.solver.solverCommit = '0'.repeat(40); },
  'wrong-reference': x => { x.identities.reference.sha256 = '0'.repeat(64); },
  'wrong-file': x => { x.files['api.zip'] = '0'.repeat(64); },
})) {
  const fixture = structuredClone(gpu); mutate(fixture); save('test-gpu-' + name + '.json', fixture);
}
