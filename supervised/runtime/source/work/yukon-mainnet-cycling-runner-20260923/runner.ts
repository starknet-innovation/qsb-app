import type {Cpu} from './runtime-api';
import {IdentityIndex} from '../yukon-indexed-controller-20260923/identity-index';
import type {Store} from '../../outputs/qsb-vault/server/store';
import {IndexedParentGuardStore as ParentGuardStore} from '../yukon-joint-composition-20260923/indexed-parent-guard';
import {saveObservation,savedTerminal} from '../yukon-indexed-controller-20260923/observations';
import {composedChild} from './composed-child';
import {ProviderIO} from '../yukon-indexed-controller-20260923/provider-io';
import {validateExecution,type Observation} from '../yukon-indexed-controller-20260923/execution-gate';
import {publicEventFactory} from './event-factory';
import {drive} from './driver';
const ADAPTER='f82d12eb4ef56db8d1a896572d6397d3cd9c167830c48abfa9fa184eb883274e';
export type Config={parent:string;scope:string;owner:string;revision:number;endpoint:string;deadlineMs:number;submissionCutoffMs:number;maxSubmissions:number;maxOperations:number;pollIntervalMs:number};
/** Operational entry only for an already atomically linked and activated child. */
export async function operate(store:Store,config:Config,provider:ProviderIO,observe:()=>Promise<Observation>,operation:string,intent:string|undefined,cpu:Cpu,signal?:AbortSignal){
 const c=structuredClone(config);const evidenceOnly=['reconcile','recover-id'].includes(operation);if(signal?.aborted)throw Error('Operation aborted');
 if(!['plan','preflight','run','submit','poll','reconcile','recover-id','retire','advance'].includes(operation)||![c.parent,c.scope].every(x=>/^isolated-yukon-[a-z0-9-]+$/.test(x))||c.parent===c.scope||typeof c.owner!=='string'||!c.owner||!Number.isSafeInteger(c.revision)||c.revision<1||provider.endpoint!==c.endpoint)throw Error('Invalid composed operation');
 const [parent,child]=await Promise.all([store.get('VALIDATION#'+c.parent,'SCOPE'),store.get('VALIDATION#'+c.scope,'SCOPE')]);
 if(!parent||!child||[parent,child].some(x=>x.identitySchema!=='provider-index-v1')||(!evidenceOnly&&[parent,child].some(x=>x.identityConflict))||[parent,child].some(x=>x.owner!==c.owner)||(evidenceOnly?(!Number.isSafeInteger(child.revision)||(child.revision as number)<c.revision):child.revision!==c.revision)||(!evidenceOnly&&parent.revision!==c.revision)||parent.childScope!==c.scope||child.parentScope!==c.parent||typeof parent.pinReceiptHash!=='string'||!parent.pinReceiptHash||parent.pinReceiptHash!==child.pinReceiptHash||child.endpoint!==c.endpoint||child.adapterHash!==ADAPTER||child.dispatchAuthorized!==true||typeof child.template!=='string')throw Error('Unbound composed child');
 const budget=child.budget as {deadlineMs:number;submissionCutoffMs:number;maxSubmissions:number;maxConcurrent:number}|undefined;
 if(!budget||!Number.isSafeInteger(c.deadlineMs)||!Number.isSafeInteger(c.maxSubmissions)||c.maxSubmissions<1||!Number.isSafeInteger(c.submissionCutoffMs)||c.submissionCutoffMs<0||c.submissionCutoffMs>c.deadlineMs||budget.submissionCutoffMs!==c.submissionCutoffMs||budget.deadlineMs!==c.deadlineMs||budget.maxSubmissions!==c.maxSubmissions||budget.maxConcurrent!==1)throw Error('Composed budget mismatch');
 if(operation==='recover-id'){
  if(!intent||!/^RANGE#round[12]:(0|[1-9][0-9]*)$/.test(intent))throw Error('Explicit intent required');
  const row=await new IdentityIndex(new ParentGuardStore(store,c.parent,c.scope,c.owner,c.revision),c.scope,c.owner,c.revision).recover(intent);
  return {recovered:true,provider:row.provider,creditGranted:false,stageAdvanced:false,submitted:false};
 }
 if(operation==='reconcile'){
  if(!intent||!/^RANGE#round[12]:(0|[1-9][0-9]*)$/.test(intent))throw Error('Explicit intent required');
  const r=await store.get(child.pk,intent);if(!r||r.owner!==c.owner||r.revision!==c.revision||typeof r.provider!=='string')throw Error('Unattached reconciliation');
  const previous=await savedTerminal(store,r),result=previous??await provider.read(c.endpoint,r.provider);
  if(result?.id!==r.provider||!['IN_QUEUE','IN_PROGRESS','COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(result.status))throw Error('Invalid reconciliation result');
  if(['IN_QUEUE','IN_PROGRESS'].includes(result.status))return {reconciled:false,status:result.status};
  if(previous===undefined){
   try{await saveObservation(new ParentGuardStore(store,c.parent,c.scope,c.owner,c.revision),child,r,result);}
   catch(error){const durable=await savedTerminal(store,r);if(JSON.stringify(durable)!==JSON.stringify(result))throw error;}
  }
  return {reconciled:true,status:result.status,provider:r.provider,creditGranted:false,stageAdvanced:false};
 }
 class AbortAwareProvider extends ProviderIO {
  constructor(){super(provider.endpoint,`https://api.runpod.ai/v2/${provider.endpoint}/run`,'delegated-unused');}
  override send(endpoint:string,event:unknown){if(signal?.aborted)throw Error('Operation aborted before paid request');if(Date.now()>=c.submissionCutoffMs)throw Error('Submission cutoff before paid request');return provider.send(endpoint,event);}
  override read(endpoint:string,id:string){return provider.read(endpoint,id);}
 }
 const guardedObserve=async()=>{if(signal?.aborted)throw Error('Operation aborted');const observation=await observe();if(signal?.aborted)throw Error('Operation aborted');if(Date.now()>=c.submissionCutoffMs)throw Error('Submission cutoff after preflight');return observation;};
 const controller=composedChild(store,c.parent,c.scope,c.owner,c.revision,new AbortAwareProvider(),guardedObserve,cpu);
 if(operation==='plan')return controller.plan();
 if(operation==='preflight'){validateExecution(c.endpoint,c.deadlineMs,await observe());return {preflight:true};}
 if(operation==='run')return drive(controller,publicEventFactory(JSON.parse(child.template),cpu),{maxOperations:c.maxOperations,deadlineMs:c.deadlineMs,pollIntervalMs:c.pollIntervalMs,submissionCutoffMs:c.submissionCutoffMs,signal});
 if(operation==='advance'){await controller.advance();return {advanced:true};}
 if(!intent||!/^RANGE#round[12]:(0|[1-9][0-9]*)$/.test(intent))throw Error('Explicit intent required');
 if(operation==='submit'&&Date.now()>=c.submissionCutoffMs)throw Error('Submission cutoff');
 if(operation==='submit'){const r=await controller.submit(intent);return {submitted:r.sk,provider:r.provider};}
 if(operation==='retire'){await controller.retireUnsubmitted(intent);return {retired:intent};}
 return {poll:await controller.poll(intent)};
}
