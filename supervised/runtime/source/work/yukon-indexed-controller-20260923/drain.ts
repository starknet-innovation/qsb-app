/** Isolated draining: provider reads are injected, never inferred from queue totals. */
import {SCHEMA} from './identity-index';
import type {Store,Row} from '../../outputs/qsb-vault/server/store';
export type Terminal={id:string;status:'COMPLETED'|'FAILED'|'CANCELLED'|'TIMED_OUT';observedAt:string};
export class Drain {
 constructor(private store:Store,private scope:string,private owner:string,private revision:number){
  if(!/^isolated-yukon-[a-z0-9-]+$/.test(scope))throw Error('Isolated scope required');
 }
 private pk(){return 'VALIDATION#'+this.scope;}
 private async guard(){const s=await this.store.get(this.pk(),'SCOPE');if(!s||s.identitySchema!==SCHEMA||s.identityConflict||s.owner!==this.owner||s.revision!==this.revision||s.phase!=='draining'||!['round1','round2'].includes(s.stage as string))throw Error('Not current draining owner');return s;}
 private valid(r:Row,s:Row){if(r.owner!==this.owner||r.revision!==this.revision||!r.sk.startsWith(`RANGE#${s.stage}:`))throw Error('Wrong intent context');}
 async retireReserved(sk:string){const s=await this.guard(),r=await this.store.get(this.pk(),sk);if(!r)throw Error('Missing intent');this.valid(r,s);if(r.state!=='reserved'||r.provider)throw Error('Possibly submitted');await this.store.atomicPut([{row:{...s,version:s.version+1},expected:s.version},{row:{...r,version:r.version+1,state:'unsubmitted_retired'},expected:r.version}]);}
 async terminal(sk:string,read:(id:string)=>Promise<Terminal>){
  const before=await this.guard(),r=await this.store.get(this.pk(),sk);if(!r)throw Error('Missing intent');this.valid(r,before);
  if(!['attached','candidate_verified','range_complete'].includes(r.state as string)||typeof r.provider!=='string')throw Error('Unresolved submission');
  const e=structuredClone(await read(r.provider));
  if(e.id!==r.provider||!['COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(e.status)||!Number.isFinite(Date.parse(e.observedAt)))throw Error('Not explicit terminal evidence');
  const s=await this.guard();if(s.stage!==before.stage)throw Error('Stage changed');
  // Preserve cryptographic receipt and coverage; terminal status alone earns no credit.
  await this.store.atomicPut([{row:{...s,version:s.version+1},expected:s.version},{row:{...r,version:r.version+1,terminal:e},expected:r.version}]);
 }
 async advance(){
  const s=await this.guard(),rows=await this.store.list(this.pk(),`RANGE#${s.stage}:`);
  const solutions=s.solutions as Record<string,number[]>|undefined;
  const solution=solutions?.[s.stage as string];
  if(!solution||solution.length!==9||new Set(solution).size!==9||solution.some(x=>!Number.isInteger(x)||x<0||x>=150))throw Error('Missing verified solution');
  if(!rows.some(r=>r.state==='candidate_verified'&&JSON.stringify((r.receipt as any)?.verdict?.indices)===JSON.stringify(solution)))throw Error('Missing solution receipt');
  for(const r of rows){this.valid(r,s);if(r.state==='unsubmitted_retired'&&!r.provider)continue;const e=r.terminal as Terminal|undefined;if(!['attached','candidate_verified','range_complete'].includes(r.state as string)||!e||e.id!==r.provider||!['COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(e.status))throw Error('Sibling not drained');}
  // All reservation/submission/publication/terminal changes contend on scope version.
  // Late attachment can only change uncertain rows, which block this transition.
  const next=s.stage==='round1'?{stage:'round2',phase:'searching'}:{phase:'awaiting_authorization'};
  await this.store.put({...s,...next,version:s.version+1},s.version);
 }
}
