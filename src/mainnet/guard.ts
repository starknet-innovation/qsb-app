import {browserLocalAssembly} from './assembly';
import {publicVaultSchema} from '../lib/model';
import {persistentGuard} from './persistentGuard';
export {persistentGuard} from './persistentGuard';
/** Serializes participating mainnet tabs only. Human download/approval does not hold this lock. */
export function lockedAssembly(assembly:ReturnType<typeof browserLocalAssembly>,locks:Pick<LockManager,'request'>|undefined,isCurrent:()=>boolean=()=>true){
 const run=async<T>(input:unknown,fn:()=>Promise<T>)=>{if(!locks)throw Error('This browser cannot safely coordinate local signing. Use a browser with Web Locks.');const vault=publicVaultSchema.parse((input as {vault?:unknown})?.vault);return locks.request('qsb-mainnet-assembly:'+vault.scriptHash,{mode:'exclusive'},()=>{if(!isCurrent())throw Error('Wallet or session changed before local assembly.');return fn();});};
 return {prepare:(...a:Parameters<typeof assembly.prepare>)=>run(a[0],()=>assembly.prepare(...a)),reimport:(...a:Parameters<typeof assembly.reimport>)=>run(a[0],()=>assembly.reimport(...a))};
}
export function browserGuardedAssembly(isCurrent:()=>boolean=()=>true){return lockedAssembly(browserLocalAssembly(persistentGuard(localStorage)),navigator.locks,isCurrent);}
