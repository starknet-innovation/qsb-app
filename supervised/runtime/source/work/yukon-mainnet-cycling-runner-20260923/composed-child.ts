import type {Cpu} from './runtime-api';
import type {Store} from '../../outputs/qsb-vault/server/store';
import {Controller} from './subset-controller';
import {ProviderIO} from '../yukon-indexed-controller-20260923/provider-io';
import type {Observation} from '../yukon-indexed-controller-20260923/execution-gate';
import {IndexedParentGuardStore} from '../yukon-joint-composition-20260923/indexed-parent-guard';
/** Only newly prepared indexed children. No predecessor migration. */
export function composedChild(store:Store,parent:string,child:string,owner:string,revision:number,provider:ProviderIO,observe:()=>Promise<Observation>,cpu:Cpu){
 return new Controller(new IndexedParentGuardStore(store,parent,child,owner,revision),child,owner,revision,provider,observe,cpu);
}
