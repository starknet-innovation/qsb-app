import React,{useEffect,useRef,useState} from 'react';
import {publicSignedResult} from './publicResult';
import {base64} from '@scure/base';
import {exactSigningIntentDisplay} from './intent';
import {chainCheckedSigning} from './flow';
type Flow=ReturnType<typeof chainCheckedSigning>;
type Wallet={address:string;publicKey:string};
type Props={contract:unknown;wallet:Wallet;walletEpoch:number;flow:Flow;signPsbt:(address:string,psbt:string,indices:number[])=>Promise<string>};
export function MainnetApproval(props:Props){
 let parsed:ReturnType<typeof exactSigningIntentDisplay>|undefined,error='';
 try{parsed=exactSigningIntentDisplay(props.contract);if(parsed.contract.helperAddress!==props.wallet.address||parsed.contract.helperPublicKey!==props.wallet.publicKey)throw Error('Connected wallet differs from helper.');}catch{error='Invalid intent or wallet binding.';}
 const key=parsed?`${parsed.intentHash}:${props.wallet.address}:${props.wallet.publicKey}:${props.walletEpoch}`:error;
 // Render-time boundary invalidates async results before effects run.
 const active=useRef({key,epoch:0,flow:props.flow,sign:props.signPsbt});
 if(active.current.key!==key||active.current.flow!==props.flow||active.current.sign!==props.signPsbt)active.current={key,epoch:active.current.epoch+1,flow:props.flow,sign:props.signPsbt};
 const [state,setState]=useState<{key:string;identity:object;status:string;psbt?:Uint8Array;approval?:unknown;result?:string}>({key,identity:active.current,status:'inspect'});
 const visible=state.key===key&&state.identity===active.current?state:{key,identity:active.current,status:'inspect'};
 const busy=useRef(false);
 useEffect(()=>{busy.current=false;setState({key,identity:active.current,status:'inspect'});return()=>{active.current.epoch++;};},[key,props.flow,props.signPsbt]);
 async function act(sign:boolean){
  if(!parsed||error||busy.current)return;
  const identity=active.current,epoch=identity.epoch;busy.current=true;
  const current=()=>active.current===identity&&active.current.epoch===epoch;
  const contract=structuredClone(parsed.contract),approval=sign?visible.approval:{format:'qsb-mainnet-exact-approval-v1',network:'mainnet',intentHash:parsed.intentHash,action:'request-xverse-signature',approved:true};
  setState({key,identity:active.current,status:'checking'});
  try{
   if(!sign){const p=await props.flow.prepare(contract,approval);if(current())setState({key,identity:active.current,status:'approved',psbt:p.psbt,approval});}
   else{
    if(!visible.psbt||!approval)throw Error('Inspect and approve again.');
    const returned=await props.signPsbt(props.wallet.address,base64.encode(visible.psbt),[0]);
    if(!current())return;
    const result=await props.flow.accept(contract,approval,base64.decode(returned));
    if(current())setState({key,identity:active.current,status:'verified',result:JSON.stringify(publicSignedResult(contract,result))});
   }
  }catch{if(current())setState({key,identity:active.current,status:'rejected — inspect and approve again'});}
  finally{if(current())busy.current=false;}
 }
 function downloadResult(){if(!parsed||!visible.result||visible.identity!==active.current)return;const bytes=visible.result,output=JSON.parse(bytes);if(output.intentHash!==parsed.intentHash)return;const url=URL.createObjectURL(new Blob([bytes],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`qsb-mainnet-public-signed-result-${output.requestId}.json`;a.click();URL.revokeObjectURL(url);}
 if(error||!parsed)return <section><p role="alert">{error}</p></section>;
 return <section><h2>Review exact Bitcoin mainnet transaction</h2><p>No broadcast is authorized by this screen.</p>
 <dl>{parsed.lines.map(({label,value})=><React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>
 <p role="status">{visible.status}</p><button disabled={visible.status==='checking'} onClick={()=>act(false)}>Approve this exact transaction for Xverse signing</button>
 <button disabled={visible.status!=='approved'} onClick={()=>act(true)}>Request Xverse signature — no broadcast</button>
 {visible.result&&<><button onClick={downloadResult}>Download public signed result — no broadcast</button><p data-testid="result">Helper signature verified for this exact intent. QSB consensus and chain inclusion are not established here. No broadcast is authorized.</p></>}
 </section>;
}
