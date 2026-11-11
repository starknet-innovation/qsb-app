import { beforeEach, expect, it, vi } from 'vitest';
const fixture=vi.hoisted(()=>({digest:Uint8Array.from([0x30,0x1d,2,1,1,2,24,...Array(24).fill(1),1])}));
vi.mock('../src/pqb-core/grind',async original=>({
  ...await original<typeof import('../src/pqb-core/grind')>(),
  evaluate:vi.fn(()=>({digest:fixture.digest,z:1n})),
}));
import {checkPqbHit} from '../src/lib/pqb';
import {evaluate,type Packet} from '../src/pqb-core/grind';
const packet={kind:'pinning',stage:0,verify_form:false} as Packet;
beforeEach(()=>vi.clearAllMocks());
// A constructed digest isolates policy. It is not a found hash-puzzle solution.
it('re-derives but does not accept a hybrid-encoded solution',()=>{
  expect(checkPqbHit(packet,'2147483648 500000000 0 0 2 1')).toBeNull();
  expect(evaluate).toHaveBeenCalledOnce();
});
it.each([0,1])('retains the compressed/uncompressed encoding %s',encoding=>{
  expect(checkPqbHit(packet,`2147483648 500000000 0 0 ${encoding} 1`)).toMatchObject({encoding,stage:0});
  expect(evaluate).toHaveBeenCalledOnce();
});
