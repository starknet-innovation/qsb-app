import React,{useEffect,useRef,useState} from 'react';
import {fingerprint} from '../lib/provenance';
import {MainnetRecoveryHost,type HostProps} from './RecoveryHost';
import {bindSolvedConsumer,type Dependencies} from './consumer';
type Props={originalRequest:unknown;solvedState:unknown;previous:{fundingPreviousTxHex:string;helperPreviousTxHex:string};wallet:HostProps['wallet'];walletEpoch:number;dependencies:Dependencies};
/** Unmounted isolated consumer; trusted dependencies come from application wiring, never imported JSON. */
export function MainnetSolvedRecovery(p:Props){
 const key=fingerprint({request:p.originalRequest,solved:p.solvedState,previous:p.previous,wallet:p.wallet,epoch:p.walletEpoch});
 const identity=useRef({key,deps:p.dependencies});if(identity.current.key!==key||identity.current.deps!==p.dependencies)identity.current={key,deps:p.dependencies};
 const [state,set]=useState<{identity:object;bound?:Awaited<ReturnType<typeof bindSolvedConsumer>>;error?:boolean}>({identity:identity.current});
 const visible=state.identity===identity.current?state:{identity:identity.current};
 useEffect(()=>{const id=identity.current;let cancelled=false,bound:Awaited<ReturnType<typeof bindSolvedConsumer>>|undefined;
  set({identity:id});bindSolvedConsumer(p.originalRequest,p.solvedState,p.previous,p.dependencies,()=>!cancelled&&identity.current===id).then(b=>{bound=b;if(cancelled||identity.current!==id){b.dispose();return;}if(b.input.wallet.address!==p.wallet.address||b.input.wallet.publicKey!==p.wallet.publicKey){b.dispose();set({identity:id,error:true});return;}set({identity:id,bound:b});}).catch(()=>{if(!cancelled&&identity.current===id)set({identity:id,error:true});});
  return()=>{cancelled=true;bound?.dispose();p.dependencies.lock();};
 },[key,p.dependencies]);
 if(visible.error)return <p role="alert">Solved result is not currently admitted for the original request and connected wallet.</p>;
 if(!visible.bound)return <p role="status">Checking current service admission…</p>;
 const b=visible.bound;
 return <MainnetRecoveryHost input={b.input} wallet={p.wallet} walletEpoch={p.walletEpoch} assembly={b.assembly} lock={p.dependencies.lock} flow={b.flow} signPsbt={b.signPsbt}/>;
}
