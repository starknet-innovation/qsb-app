import React,{useEffect,useRef,useState} from 'react';
import {fingerprint} from '../lib/provenance';
import {MainnetApproval} from './Approval';
import {browserLocalAssembly} from './assembly';
import {lockQsb} from '../lib/qsb';
type Assembly=ReturnType<typeof browserLocalAssembly>;
type ApprovalProps=React.ComponentProps<typeof MainnetApproval>;
export type HostProps={input:unknown;wallet:ApprovalProps['wallet'];walletEpoch:number;assembly:Assembly;lock:()=>void;flow:ApprovalProps['flow'];signPsbt:ApprovalProps['signPsbt']};
export function MainnetRecoveryHost(p:HostProps){
 const key=fingerprint({input:p.input,wallet:p.wallet,epoch:p.walletEpoch});
 const identity=useRef({key,assembly:p.assembly,lock:p.lock});
 if(identity.current.key!==key||identity.current.assembly!==p.assembly||identity.current.lock!==p.lock)identity.current={key,assembly:p.assembly,lock:p.lock};
 const [state,set]=useState<{id:object;backup:string;pass:string;sealed?:string;downloaded?:boolean;selected?:string;contract?:unknown;busy?:boolean;error?:string}>({id:identity.current,backup:'',pass:''});
 const current=state.id===identity.current?state:{id:identity.current,backup:'',pass:''};
 const active=useRef<object|null>(null);const urls=useRef<string[]>([]);
 useEffect(()=>{set({id:identity.current,backup:'',pass:''});return()=>{active.current=null;p.lock();for(const u of urls.current)URL.revokeObjectURL(u);urls.current=[];};},[key,p.assembly,p.lock]);
 function patch(v:Partial<typeof state>){set({...current,...v,id:identity.current});}
 async function file(e:React.ChangeEvent<HTMLInputElement>,kind:'backup'|'selected'){
  const id=identity.current,f=e.target.files?.[0];if(!f)return;
  try{if(f.size>260000)throw Error();const text=await f.text();if(identity.current!==id)return;set(s=>s.id===id?{...s,[kind]:text,error:undefined}:s);}catch{if(identity.current===id)patch({error:'Unable to read backup.'});}
 }
 async function run(reimport:boolean){
  if(current.busy||active.current)return;const id=identity.current;active.current=id;
  const snap=structuredClone(p.input),wallet={...p.wallet},pass=current.pass;
  patch({busy:true,error:undefined,contract:undefined});
  try{
   if(reimport&&(!current.downloaded||!current.sealed||current.selected!==current.sealed))throw Error();
   const result=reimport?await p.assembly.reimport(snap,wallet,current.selected!,current.sealed!,pass):await p.assembly.prepare(snap,wallet,current.backup,pass);
   if(identity.current!==id||active.current!==id)return;
   if(reimport){if(result.kind!=='ready')throw Error();set({id,backup:'',pass:'',contract:result.contract});}
   else{if(result.kind!=='sealed')throw Error();set({id,backup:'',pass:'',sealed:result.encryptedSigningBackup});}
  }catch{if(identity.current===id&&active.current===id)set({id,backup:'',pass:'',error:'Recovery or commitment check rejected. Restart with the correct backup.'});}
  finally{if(active.current===id)active.current=null;}
 }
 function download(){if(!current.sealed||current.busy)return;const u=URL.createObjectURL(new Blob([current.sealed],{type:'application/json'}));urls.current.push(u);const a=document.createElement('a');a.href=u;a.download='qsb-mainnet-private-signing-backup.json';a.click();patch({downloaded:true});}
 return <section key={key}><h2>Unlock locally and preserve the signing backup</h2><p>Your backup and passphrase stay in this browser. No broadcast is available.</p>
 {!current.contract&&<><label>Private backup<input key={`${key}:${!!current.sealed}`} aria-label="Private backup" type="file" disabled={current.busy||!!current.sealed} onChange={e=>file(e,'backup')}/></label>
 <label>Passphrase<input aria-label="Passphrase" type="password" autoComplete="off" value={current.pass} disabled={current.busy} onChange={e=>patch({pass:e.target.value})}/></label>
 <button disabled={current.busy||!current.backup||!current.pass||!!current.sealed} onClick={()=>run(false)}>Unlock and seal signing backup</button>
 <button disabled={!current.sealed||current.busy} onClick={download}>Download signing backup</button>
 <input aria-label="Reimport downloaded signing backup" type="file" disabled={!current.downloaded||current.busy} onChange={e=>file(e,'selected')}/>
 <button disabled={!current.downloaded||current.selected!==current.sealed||!current.pass||current.busy} onClick={()=>run(true)}>Verify reimport and assemble locally</button></>}
 {current.error&&<p role="alert">{current.error}</p>}
 {!!current.contract&&<MainnetApproval contract={current.contract} wallet={p.wallet} walletEpoch={p.walletEpoch} flow={p.flow} signPsbt={p.signPsbt}/>}
 </section>;
}
/** Existing browser worker; caller supplies fail-closed persistent commitment guard. */
export function createBrowserAssemblyHost(guard:Parameters<typeof browserLocalAssembly>[0]){return {assembly:browserLocalAssembly(guard),lock:lockQsb};}
