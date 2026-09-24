import type {Store,Row} from '../../outputs/qsb-vault/server/store';
/** Internal child-controller Store adapter. Strict identity evidence is handled by the outer indexed guard; immutable journals remain available.
 * Every ordinary child scope mutation must atomically contend with the linked parent.
 * Not an authorization boundary for arbitrary callers with access to the underlying Store.
 */
export class ParentGuardStore implements Store {
 private parentPk:string;private childPk:string;
 constructor(private base:Store,parent:string,child:string,private owner:string,private revision:number){
  if(![parent,child].every(x=>/^isolated-yukon-[a-z0-9-]+$/.test(x))||parent===child||!owner||!Number.isSafeInteger(revision)||revision<1)throw Error('Invalid composition guard');
  this.parentPk='VALIDATION#'+parent;this.childPk='VALIDATION#'+child;
 }
 get(pk:string,sk:string){return this.base.get(pk,sk);}
 list(pk:string,prefix:string){return this.base.list(pk,prefix);}
 async delete(pk:string,sk:string,expected:number){if(pk===this.childPk)throw Error('Child inventory deletion forbidden');return this.base.delete(pk,sk,expected);}
 put(row:Row,expected?:number){return this.atomicPut([{row,expected}]);}
 async atomicPut(input:{row:Row;expected?:number}[]){
  const writes=structuredClone(input);
  if(writes.some(w=>w.row.pk===this.parentPk))throw Error('Parent mutation requires parent operator');
  const child=writes.find(w=>w.row.pk===this.childPk&&w.row.sk==='SCOPE');
  if(child){
   const [p,before]=await Promise.all([this.base.get(this.parentPk,'SCOPE'),this.base.get(this.childPk,'SCOPE')]),c=child.row;
   const pause=c.phase==='paused'&&c.revision===this.revision+1&&before?.revision===this.revision&&before.owner===this.owner&&child.expected===before.version;
   if(!p||p.identitySchema!=='provider-index-v1'||c.identitySchema!=='provider-index-v1'||p.identityConflict||c.identityConflict||p.phase!=='subset_running'||p.owner!==this.owner||p.revision!==this.revision||p.childScope!==this.childPk.slice(11)||c.owner!==this.owner||(c.revision!==this.revision&&!pause)||c.parentScope!==this.parentPk.slice(11)||typeof p.pinReceiptHash!=='string'||c.pinReceiptHash!==p.pinReceiptHash)throw Error('Parent no longer authorizes child search');
   writes.push({row:{...p,version:p.version+1},expected:p.version});
  }
  return this.base.atomicPut(writes);
 }
}
