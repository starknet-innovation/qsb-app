import type {Store,Row} from '../../outputs/qsb-vault/server/store';
import {ParentGuardStore} from './parent-guard-store';
import {SCHEMA} from '../yukon-indexed-controller-20260923/identity-index';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
/** Internal composition adapter, not an authorization boundary against raw Store access. */
export class IndexedParentGuardStore implements Store {
 private normal:ParentGuardStore;private pk:string;private parentPk:string;
 constructor(private base:Store,parent:string,child:string,private owner:string,private revision:number){this.normal=new ParentGuardStore(base,parent,child,owner,revision);this.pk='VALIDATION#'+child;this.parentPk='VALIDATION#'+parent;}
 get(pk:string,sk:string){return this.base.get(pk,sk);}
 list(pk:string,prefix:string){return this.base.list(pk,prefix);}
 delete(pk:string,sk:string,expected:number){return this.normal.delete(pk,sk,expected);}
 put(row:Row,expected?:number){return this.atomicPut([{row,expected}]);}
 async atomicPut(writes:{row:Row;expected?:number}[]){
  if(await this.identityEvidenceOnly(writes))return this.base.atomicPut(writes);
  return this.normal.atomicPut(writes);
 }
 private async identityEvidenceOnly(w:{row:Row;expected?:number}[]){
  const scope=w.find(x=>x.row.pk===this.pk&&x.row.sk==='SCOPE');
  const idx=w.find(x=>x.row.pk===this.pk&&x.row.sk.startsWith('IDENTITY#'));
  if(!scope||!idx||![3,4].includes(w.length))return false;
  const intent=w.find(x=>x.row.pk===this.pk&&x.row.sk===idx.row.intent);
  if(!intent)return false;
  const [s,i,x,p]=await Promise.all([this.base.get(this.pk,'SCOPE'),this.base.get(this.pk,intent.row.sk),this.base.get(this.pk,idx.row.sk),this.base.get(this.parentPk,'SCOPE')]);
  if(!s||!i||!x||!p||x.intent!==i.sk||x.sk!=='IDENTITY#'+i.sk||!Number.isSafeInteger(s.revision)||(s.revision as number)<this.revision||s.identitySchema!==SCHEMA||p.identitySchema!==SCHEMA||x.schema!==SCHEMA||s.owner!==this.owner||i.owner!==this.owner||i.revision!==this.revision||x.owner!==this.owner||x.revision!==this.revision||p.owner!==this.owner||p.childScope!==this.pk.slice(11)||s.parentScope!==this.parentPk.slice(11)||typeof p.pinReceiptHash!=='string'||s.pinReceiptHash!==p.pinReceiptHash)return false;
  for(const [write,old] of [[scope,s],[intent,i],[idx,x]] as const)if(write.expected!==old.version||write.row.version!==old.version+1)return false;
  const extra=w.filter(z=>z!==scope&&z!==intent&&z!==idx)[0];
  if(!extra){const global=typeof x.first==='string'?await this.base.get('VALIDATION#YUKON_PROVIDER_IDS',createHash('sha256').update(x.first).digest('hex')):undefined;return global?.provider===x.first&&global?.scope===this.pk.slice(11)&&global?.intent===i.sk&& i.state==='attached'&&i.provider===x.first&&x.count===1&&!x.ambiguous&&!s.identityConflict&&!i.identityConflict&&isDeepStrictEqual(scope.row,{...s,version:s.version+1})&&isDeepStrictEqual(intent.row,{...i,version:i.version+1})&&isDeepStrictEqual(idx.row,{...x,version:x.version+1});}
  const record=extra.row.pk===this.pk&&extra.row.sk.startsWith('PROVIDER_OBS#');
  const attach=extra.row.pk==='VALIDATION#YUKON_PROVIDER_IDS';
  if(extra.expected!==undefined||(!record&&!attach))return false;
  let ns:Row={...s,version:s.version+1},ni:Row={...i,version:i.version+1},nx:Row={...x,version:x.version+1};
  if(record){
   if(extra.row.schema!==SCHEMA||extra.row.owner!==this.owner||extra.row.revision!==this.revision||extra.row.intent!==i.sk||typeof extra.row.provider!=='string'||i.state==='reserved'||i.state==='unsubmitted_retired')return false;
   if(extra.row.sk!=='PROVIDER_OBS#'+i.sk+':'+createHash('sha256').update(extra.row.provider as string).digest('hex'))return false;
   const conflict=(x.count as number)>0;
   nx={...nx,count:(x.count as number)+1,first:x.first??extra.row.provider,ambiguous:conflict||x.ambiguous};
   if(conflict){ns={...ns,phase:'identity_conflict',identityConflict:true};ni={...ni,identityConflict:true};}
  }else{
   if(i.state!=='uncertain'||x.count!==1||x.ambiguous||s.identityConflict||i.identityConflict||extra.row.provider!==x.first||extra.row.scope!==this.pk.slice(11)||extra.row.intent!==i.sk)return false;
   if(extra.row.sk!==createHash('sha256').update(x.first as string).digest('hex'))return false;
   ni={...ni,state:'attached',provider:x.first};
  }
  return isDeepStrictEqual(scope.row,ns)&&isDeepStrictEqual(intent.row,ni)&&isDeepStrictEqual(idx.row,nx);
 }
}
