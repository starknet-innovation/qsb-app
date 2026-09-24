/** Isolated CAS submission bridge over the application's existing Store contract. */
import { IdentityIndex, SCHEMA } from './identity-index';
import type { Store, Row } from '../../outputs/qsb-vault/server/store';
export type Intent = Row & { state: 'reserved'|'uncertain'|'attached'; frozen: string; provider?: string };
export class GuardedIntents {
  constructor(private store: Store, private scope: string, private owner: string, private revision: number) {
    if (!owner || !Number.isSafeInteger(revision) || revision<1) throw Error('Owner and positive revision required');
    if (!/^isolated-yukon-[a-z0-9-]+$/.test(scope)) throw Error('Isolated scope required');
  }
  private pk() { return `VALIDATION#${this.scope}`; }
  async initialize(stage: 'round1'|'round2' = 'round1') {
    if (stage!=='round1') throw Error('Cannot skip first subset');
    await this.store.put({pk:this.pk(),sk:'SCOPE',version:1,owner:this.owner,revision:this.revision,phase:'searching',stage,identitySchema:SCHEMA});
  }
  private async guard(stage?:string) {
    const row=await this.store.get(this.pk(),'SCOPE');
    if (!row || row.identitySchema!==SCHEMA || row.owner!==this.owner || row.revision!==this.revision || row.phase!=='searching' || (stage && row.stage!==stage)) throw Error('Stale owner/revision/phase/stage');
    return row;
  }
  async pause() {
    const row=await this.guard();
    await this.store.put({...row,version:row.version+1,revision:this.revision+1,phase:'paused'},row.version);
  }
  async pauseForTerminal(sk:string,e:{id:string;status:string;observedAt:string}) {
    if(!['FAILED','CANCELLED','TIMED_OUT'].includes(e.status)||!Number.isFinite(Date.parse(e.observedAt)))throw Error('Explicit failed terminal required');
    const scope=await this.guard(sk.split(':')[0].replace('RANGE#',''));
    const intent=await this.store.get(this.pk(),sk);
    if(!intent || intent.state!=='attached' || intent.owner!==this.owner || intent.revision!==this.revision || intent.provider!==e.id)throw Error('Wrong terminal intent');
    await this.store.atomicPut([
      {row:{...scope,version:scope.version+1,revision:this.revision+1,phase:'paused'},expected:scope.version},
      {row:{...intent,version:intent.version+1,terminal:structuredClone(e)},expected:intent.version},
    ]);
  }
  async reserve(range: string, request: unknown, verify: (request: unknown)=>Promise<void>) {
    if (!/^(round1|round2):[0-9]+$/.test(range)) throw Error('Subset range required');
    // Freeze before async verification; caller mutations must not change paid payload.
    const frozen=JSON.stringify(request);
    if (!frozen || Buffer.byteLength(frozen)>200000) throw Error('Oversized request');
    await verify(JSON.parse(frozen));
    const scope=await this.guard(range.split(':')[0]);
    const row: Intent={pk:this.pk(),sk:`RANGE#${range}`,version:1,state:'reserved',frozen,owner:this.owner,revision:this.revision};
    const existing=await this.store.get(row.pk,row.sk) as Intent|undefined;
    if (existing) {
      if (existing.frozen!==frozen) throw Error('Range already bound differently');
      return existing;
    }
    await this.store.atomicPut([{row:{...scope,version:scope.version+1},expected:scope.version},{row},{row:{pk:row.pk,sk:'IDENTITY#'+row.sk,version:1,owner:this.owner,revision:this.revision,intent:row.sk,count:0,ambiguous:false,schema:SCHEMA}}]);
    return row;
  }
  async configureBudget(maxSubmissions:number, deadlineMs:number) {
    const scope=await this.guard();
    if(scope.budget!==undefined)throw Error('Budget already frozen');
    if(!Number.isSafeInteger(maxSubmissions)||maxSubmissions<1||maxSubmissions>10000||!Number.isSafeInteger(deadlineMs)||deadlineMs<=Date.now()||deadlineMs>Date.now()+30*60*1000)throw Error('Invalid isolated test budget');
    const rows=await this.store.list(this.pk(),'RANGE#');
    if(rows.some(r=>r.state!=='reserved'))throw Error('Cannot budget previously submitted work');
    await this.store.put({...scope,version:scope.version+1,budget:{maxSubmissions,deadlineMs,claimed:0,maxConcurrent:1}},scope.version);
  }
  async submit(sk: string, send: (request: unknown)=>Promise<string>) {
    const current=await this.store.get(this.pk(),sk) as Intent|undefined;
    if (!current || current.state!=='reserved') throw Error('Missing, submitted or uncertain intent');
    const scope=await this.guard(sk.split(':')[0].replace('RANGE#',''));
    if (current.owner!==this.owner || current.revision!==this.revision) throw Error('Intent revision mismatch');
    let nextScope:Row={...scope,version:scope.version+1};
    const budget=scope.budget as {maxSubmissions:number;deadlineMs:number;claimed:number;maxConcurrent:number}|undefined;
    if(budget){
      if(!Number.isSafeInteger(budget.claimed)||budget.claimed<0||!Number.isSafeInteger(budget.maxSubmissions)||budget.claimed>=budget.maxSubmissions||budget.maxConcurrent!==1||!Number.isSafeInteger(budget.deadlineMs)||Date.now()>=budget.deadlineMs)throw Error('Submission budget exhausted or invalid');
      const rows=await this.store.list(this.pk(),'RANGE#');
      if(rows.some(r=>['uncertain','attached'].includes(r.state as string)&&!r.terminal))throw Error('Isolated slot occupied');
      nextScope={...nextScope,budget:{...budget,claimed:budget.claimed+1}};
    }
    const claimed: Intent={...current,version:current.version+1,state:'uncertain'};
    await this.store.atomicPut([{row:nextScope,expected:scope.version},{row:claimed,expected:current.version}]); // COMMIT BEFORE paid call.
    if(budget&&Date.now()>=budget.deadlineMs)throw Error('Deadline crossed after durable claim; reconcile without submission');
    const provider=await send(JSON.parse(claimed.frozen));
    if (typeof provider!=='string' || !provider || provider.length>512) throw Error('Uncertain provider identity; reconcile');
    return this.attach(sk,provider);
  }
  /** Final durable dispatch fence after slow preflight, before any provider POST. */
  async authorizeDispatch(sk:string) {
    const current=await this.store.get(this.pk(),sk) as Intent|undefined;
    if(!current || current.state!=='uncertain' || current.owner!==this.owner || current.revision!==this.revision || current.dispatchAuthorizedAtMs!==undefined)throw Error('Invalid dispatch claim');
    const scope=await this.guard(sk.split(':')[0].replace('RANGE#',''));
    const budget=scope.budget as {deadlineMs:number}|undefined;
    if(!budget || !Number.isSafeInteger(budget.deadlineMs) || Date.now()>=budget.deadlineMs)throw Error('Dispatch deadline reached');
    await this.store.atomicPut([
      {row:{...scope,version:scope.version+1},expected:scope.version},
      {row:{...current,version:current.version+1,dispatchAuthorizedAtMs:Date.now()},expected:current.version},
    ]);
    // CAS and external HTTP are not one transaction. An expired claim remains uncertain.
    if(Date.now()>=budget.deadlineMs)throw Error('Dispatch deadline crossed after fence');
  }
  async attach(sk:string,provider:string) {
    const index=new IdentityIndex(this.store,this.scope,this.owner,this.revision);
    await index.record(sk,provider);
    return index.recover(sk);
  }
  async recover(sk:string) { return new IdentityIndex(this.store,this.scope,this.owner,this.revision).recover(sk); }
}
