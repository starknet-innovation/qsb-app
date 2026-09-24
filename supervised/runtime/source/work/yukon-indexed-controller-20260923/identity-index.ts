/** New scopes only. All provider identity writers must use this transaction protocol. */
import {createHash} from 'node:crypto';
import {Conflict,type Store,type Row} from '../../outputs/qsb-vault/server/store';
export const SCHEMA='provider-index-v1';
export class IdentityIndex {
 private pk:string;
 constructor(private store:Store,private scope:string,private owner:string,private revision:number){
  if(!/^isolated-yukon-[a-z0-9-]+$/.test(scope))throw Error('Isolated scope required');
  this.pk='VALIDATION#'+scope;
 }
 private async load(sk:string){
  const [scope,intent,index]=await Promise.all([this.store.get(this.pk,'SCOPE'),this.store.get(this.pk,sk),this.store.get(this.pk,'IDENTITY#'+sk)]);
  if(!scope||scope.identitySchema!==SCHEMA||scope.owner!==this.owner||!intent||intent.owner!==this.owner||intent.revision!==this.revision||!index||index.schema!==SCHEMA||index.owner!==this.owner||index.revision!==this.revision||index.intent!==sk)throw Error('Unindexed or wrong-owner scope/intent');
  return {scope,intent,index};
 }
 async record(sk:string,provider:string){
  if(typeof provider!=='string'||!provider||provider.length>512)throw Error('Invalid provider identity');
  // Only CAS retries; never retries transport or any paid submission.
  for(let attempt=0;attempt<32;attempt++){
   const {scope,intent,index}=await this.load(sk);
   if(intent.state==='reserved'||intent.state==='unsubmitted_retired')throw Error('No durable submission claim');
   const key='PROVIDER_OBS#'+sk+':'+createHash('sha256').update(provider).digest('hex');
   const saved=await this.store.get(this.pk,key);
   if(saved){if(saved.provider!==provider||saved.intent!==sk||saved.owner!==this.owner||saved.revision!==this.revision||saved.schema!==SCHEMA)throw Error('Journal mismatch');return;}
   if(!Number.isSafeInteger(index.count)||(index.count as number)<0)throw Error('Invalid identity count');
   const conflict=(index.count as number)>0;
   const journal:Row={pk:this.pk,sk:key,version:1,provider,intent:sk,owner:this.owner,revision:this.revision,schema:SCHEMA};
   const nextIndex={...index,version:index.version+1,count:(index.count as number)+1,first:index.first??provider,ambiguous:conflict||index.ambiguous};
   try{await this.store.atomicPut([
    {row:journal}, {row:nextIndex,expected:index.version},
    {row:{...intent,version:intent.version+1,...(conflict?{identityConflict:true}:{})},expected:intent.version},
    {row:{...scope,version:scope.version+1,...(conflict?{phase:'identity_conflict',identityConflict:true}:{})},expected:scope.version},
   ]);return;}catch(e){if(!(e instanceof Conflict))throw e;}
  }
  throw Error('Identity journal contention exhausted; preserve caller receipt for reconciliation');
 }
 async recover(sk:string){
  const {scope,intent,index}=await this.load(sk);
  if(index.count!==1||index.ambiguous||scope.identityConflict||intent.identityConflict||typeof index.first!=='string')throw Error('Unknown or ambiguous identity');
  const provider=index.first;
  const journal=await this.store.get(this.pk,'PROVIDER_OBS#'+sk+':'+createHash('sha256').update(provider).digest('hex'));
  if(!journal||journal.provider!==provider||journal.schema!==SCHEMA||journal.owner!==this.owner||journal.revision!==this.revision||journal.intent!==sk)throw Error('Missing indexed journal');
  if(intent.state!=='uncertain'&&!(intent.state==='attached'&&intent.provider===provider))throw Error('Not an uncertain or matching attached intent');
  const already=intent.state==='attached';
  const next={...intent,version:intent.version+1,state:'attached',provider};
  const claim:Row={pk:'VALIDATION#YUKON_PROVIDER_IDS',sk:createHash('sha256').update(provider).digest('hex'),version:1,scope:this.scope,intent:sk,provider};
  if(already){
   const global=await this.store.get(claim.pk,claim.sk);
   if(!global||global.provider!==provider||global.scope!==this.scope||global.intent!==sk)throw Error('Missing or mismatched global identity claim');
  }
  await this.store.atomicPut([
   {row:{...scope,version:scope.version+1},expected:scope.version},
   {row:{...index,version:index.version+1},expected:index.version},
   {row:next,expected:intent.version},
   ...(!already?[{row:claim}]:[]),
  ]);
  return next;
 }
}
