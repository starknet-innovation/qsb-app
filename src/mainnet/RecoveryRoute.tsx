import {useEffect,useMemo,useRef,useState} from 'react';
import {MainnetRecoveryScreen} from './MainnetRecoveryScreen';
import {retainedRequests} from './retainedRequest';
import {currentAdmissionClient} from './admissionClient';
import {MainnetEsplora} from './chain';
import {fingerprint} from '../lib/provenance';
import {NETWORK_CONFIG,NETWORK_ID} from '../lib/network';
import {readSessionToken,readSessionEpoch} from '../lib/api';
import type {Job} from '../lib/model';
import type {Wallet} from '../lib/wallet';
import {lockQsb} from '../lib/qsb';
export function MainnetRecoveryRoute({job,wallet,walletEpoch,onClose}:{job:Job;wallet:Wallet;walletEpoch:number;onClose:()=>void}){
 const epoch=readSessionEpoch();
 const key=fingerprint({job,wallet,walletEpoch,epoch});
 const lifetime=useRef(key);lifetime.current=key;
 const [state,set]=useState<{key:string;request?:unknown;bundle?:unknown;error?:boolean}>({key});
 const reader=useMemo(()=>new MainnetEsplora(NETWORK_CONFIG.chainUrl),[]);
 const admission=useMemo(()=>currentAdmissionClient(job.id,job.vaultId,()=>{
  if(lifetime.current!==key||readSessionEpoch()!==epoch)throw Error('Session changed.');
  return readSessionToken()??'';
 }),[key,job.id,job.vaultId,epoch]);
 useEffect(()=>{let disposed=false;set({key});
  (async()=>{
   if(NETWORK_ID!=='mainnet'||job.status!=='awaiting_authorization'||job.owner!==wallet.address)throw Error('Wrong withdrawal context.');
   const request=retainedRequests(localStorage,navigator.locks).load(job.id,job.vaultId,wallet.address);
   if(request.wallet.publicKey!==wallet.publicKey||fingerprint(request.manifest)!==fingerprint(job.manifest))throw Error('Original withdrawal differs.');
   const current=await admission(request.id);
   if(!disposed&&lifetime.current===key&&readSessionEpoch()===epoch)set({key,request,bundle:current.bundle});
  })().catch(()=>{if(!disposed&&lifetime.current===key)set({key,error:true});});
  return()=>{disposed=true;lockQsb();};
 },[key,admission]);
 const visible=state.key===key?state:{key};
 return <section aria-label="Mainnet withdrawal recovery"><button onClick={onClose}>Close withdrawal review</button>
 {visible.error?<p role="alert">The original withdrawal or current authorization is unavailable. Signing is blocked.</p>:visible.request&&visible.bundle?<MainnetRecoveryScreen originalRequest={visible.request} solvedState={visible.bundle} wallet={wallet} walletEpoch={walletEpoch} sessionEpoch={epoch} reader={reader} readCurrentAdmission={admission}/>:<p role="status">Checking the original withdrawal…</p>}
 </section>;
}
