import type {Store,Row} from '../../outputs/qsb-vault/server/store';
import {SCHEMA} from '../yukon-indexed-controller-20260923/identity-index';
export async function assertIdentity(store:Store,intent:Row){
 const index=await store.get(intent.pk,'IDENTITY#'+intent.sk);
 if(!index||index.schema!==SCHEMA||index.owner!==intent.owner||index.revision!==intent.revision||index.intent!==intent.sk||index.count!==1||index.ambiguous||index.first!==intent.provider||intent.identityConflict)throw Error('Unknown or ambiguous pin identity');
 return index;
}
