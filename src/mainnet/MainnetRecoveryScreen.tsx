import {useEffect,useMemo,useRef,useState} from 'react';
import * as btc from '@scure/btc-signer';import {hex} from '@scure/base';
import {fingerprint} from '../lib/provenance';import {lockQsb} from '../lib/qsb';import {signPsbt,type Wallet} from '../lib/wallet';
import {MainnetSolvedRecovery} from './SolvedRecovery';import {validateRequest} from './solvedContract';import {chainCheckedSigning} from './flow';import type {MainnetEsplora} from './chain';import type {TrustedAdmissionReader} from './consumer';import {browserGuardedAssembly} from './guard';
export type MainnetRecoveryScreenProps={originalRequest:unknown;solvedState:unknown;wallet:Wallet;walletEpoch:number;sessionEpoch:number;reader:Pick<MainnetEsplora,'assertNetwork'|'unspent'>;readCurrentAdmission:TrustedAdmissionReader};
/** Application wiring supplies trusted chain/admission readers. No broadcast or transaction launch. */
export function MainnetRecoveryScreen(p:MainnetRecoveryScreenProps){
 const key=fingerprint({request:p.originalRequest,solved:p.solvedState,wallet:p.wallet,walletEpoch:p.walletEpoch,sessionEpoch:p.sessionEpoch});
 const identity=useRef({key,reader:p.reader,admission:p.readCurrentAdmission});if(identity.current.key!==key||identity.current.reader!==p.reader||identity.current.admission!==p.readCurrentAdmission)identity.current={key,reader:p.reader,admission:p.readCurrentAdmission};
 const [state,set]=useState<{identity:object;previous?:{fundingPreviousTxHex:string;helperPreviousTxHex:string};error?:boolean}>({identity:identity.current});const visible=state.identity===identity.current?state:{identity:identity.current};
 const mounted=useRef(false);
 const dependencies=useMemo(()=>{const id=identity.current;return {assembly:browserGuardedAssembly(()=>mounted.current&&identity.current===id),lock:lockQsb,flow:chainCheckedSigning(p.reader),readCurrentAdmission:p.readCurrentAdmission,signPsbt};},[p.reader,p.readCurrentAdmission,key]);
 useEffect(()=>{mounted.current=true;const id=identity.current;let disposed=false;set({identity:id});
  (async()=>{const request=validateRequest(structuredClone(p.originalRequest));if(request.wallet.address!==p.wallet.address||request.wallet.publicKey!==p.wallet.publicKey)throw Error('Wallet differs');await p.reader.assertNetwork();const helperScript=hex.encode(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(request.wallet.address)));const funding=await p.reader.unspent(request.manifest.funding,request.vault.scriptHex),helper=await p.reader.unspent(request.manifest.helper,helperScript);if(!disposed&&identity.current===id)set({identity:id,previous:{fundingPreviousTxHex:funding.previousTxHex,helperPreviousTxHex:helper.previousTxHex}});})().catch(()=>{if(!disposed&&identity.current===id)set({identity:id,error:true});});
  return()=>{disposed=true;mounted.current=false;lockQsb();};
 },[key,p.reader,p.readCurrentAdmission]);
 if(visible.error)return <p role="alert">The original request, wallet or current funding could not be verified.</p>;
 if(!visible.previous)return <p role="status">Checking the original mainnet funding transactions…</p>;
 return <MainnetSolvedRecovery originalRequest={p.originalRequest} solvedState={p.solvedState} previous={visible.previous} wallet={p.wallet} walletEpoch={p.walletEpoch} dependencies={dependencies}/>;
}
