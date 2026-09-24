import {validateLineage} from './lineage';
import {fingerprint} from '../../outputs/qsb-vault/src/lib/provenance';
/** Files are public evidence; expected source hashes come from reviewed application enrollment, never the uploaded request. */
import {isDeepStrictEqual} from 'node:util';
import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';import {readNoFollow} from '../read-nofollow';
import {createFinalDrain} from './drain';import {validateConfig,type Config} from '../yukon-common-operational-transport-20260923/transport';
import type {CensusStore} from '../yukon-signing-export-20260923/census-store';import type {EvidenceReaders,ReapedEvidence} from '../yukon-signing-export-20260923/publication';
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');const same=(a:any,b:any)=>isDeepStrictEqual(a,b);function need(x:any,m:string):asserts x{if(!x)throw Error(m);}
export type Enrollment={controllerHash:string;wrapperHash:string;sourceFiles:Record<string,string>};
export function createEvidenceReaders(store:CensusStore,config:Config,key:string,directory:string,enrollment:Enrollment,predecessors:Record<string,()=>Promise<ReapedEvidence>>={}):EvidenceReaders{
 const c=validateConfig(config),e=structuredClone(enrollment),root=resolve(directory),drain=createFinalDrain(c,key),configHash=hash(JSON.stringify(c.blueprint)),runPk='SUPERVISION#'+c.blueprint.runId;
 need(/^[a-f0-9]{64}$/.test(e.controllerHash)&&/^[a-f0-9]{64}$/.test(e.wrapperHash)&&e.sourceFiles['controller.cjs']===e.controllerHash&&e.sourceFiles['supervisor.py']===e.wrapperHash,'No trusted process source enrollment');
 function file(name:string){need(!name.includes('/'),'Unsafe evidence path');const b=readNoFollow(join(root,name),'Unsafe evidence path');need(b.length<64*1024*1024,'Oversized evidence');return b;}
 function shutdown(){const value=JSON.parse(file('shutdown-result.json').toString());need(value.snapshot?.runPk===runPk&&value.snapshot.configHash===configHash&&hash(JSON.stringify(value.snapshot))===value.snapshotHash,'Shutdown snapshot differs');return value;}
 async function lineageEvidence(){const owner=await store.get(runPk,'OWNER');need(owner,'Missing live owner');const first=await validateLineage(store,owner,runPk);let current:any=owner;while(current.adoption||current.contextCycle){const a=current.adoption??current.contextCycle,reader=predecessors[a.predecessor];need(typeof reader==='function','Missing trusted predecessor OS reader');const proof=await reader();need(proof.runPk===a.predecessor&&proof.configHash===a.predecessorConfigHash&&proof.snapshotHash===a.snapshotHash&&proof.processesReaped&&proof.cpuContainersAbsent&&proof.registeredRecoveryReaped&&fingerprint(proof)===a.quiescenceHash,'Predecessor OS provenance changed');current=await store.get(a.predecessor,'OWNER');need(current,'Missing predecessor');}need(same(first,await validateLineage(store,owner,runPk))&&same(owner,await store.get(runPk,'OWNER')),'Lineage changed during OS evidence');return first;}
 async function readQuiescence():Promise<ReapedEvidence>{
  const lineage=await lineageEvidence();
  const cfgBytes=file('config.json'),cfg=JSON.parse(cfgBytes.toString()),start=JSON.parse(file('started.json').toString()),receiptBytes=file('receipt.json'),r=JSON.parse(receiptBytes.toString()),journal=file('events.jsonl');
  need(cfg.format==='qsb-common-operational-entry-v1'&&same(cfg.transport,c),'Diagnostic/foreign process cannot authorize export');
  need(start.configHash===hash(cfgBytes)&&same(start.sources?.files,e.sourceFiles),'Process source/config enrollment differs');
  need(r.failure===null&&r.shutdownReady===true&&r.processesReaped===true&&r.pending?.length===0&&r.unknown?.length===0&&r.journalHash===hash(journal),'Process not authoritatively reaped');
  const lines=journal.toString().trimEnd().split('\n').map(x=>JSON.parse(x));need(lines.every((x,i)=>x.sequence===i),'Journal sequence differs');
  const registered=new Map<string,any>(),acked=new Set<string>(),observed=new Map<string,any>(),observedAck=new Set<string>(),requests=new Set<string>();let reaped=false,cleanup:any,ready:any;
  for(const row of lines){if(row.kind==='child_event'){const raw=Buffer.from(row.rawLineHex,'hex');need(same(JSON.parse(raw.toString()),row.event),'Raw event differs');const event=row.event;need(event.configHash===configHash&&event.outerConfigHash===hash(cfgBytes),'Event enrollment differs');
    if(event.event==='cpu_registered'){need(event.runPk===runPk&&!registered.has(event.operation),'CPU repeated/foreign');registered.set(event.operation,{event,hash:hash(raw)});}
    if(event.event==='request_started'){need(!requests.has(event.requestId),'Repeated request');requests.add(event.requestId);}
    if(event.event==='request_observed'){need(requests.has(event.requestId)&&!observed.has(event.requestId),'Unbound provider observation');observed.set(event.requestId,{event,hash:hash(raw)});}
    if(event.event==='request_unknown')throw Error('Unknown paid request');
    if(event.event==='request_resolved'){need(observed.get(event.requestId)?.event.providerId===event.providerId&&observedAck.has(event.requestId),'Unpreserved ID');requests.delete(event.requestId);}
    if(event.event==='not_sent_reconciled'){need(requests.has(event.requestId)&&!observed.has(event.requestId)&&event.receipt?.knownNoSend===true&&event.receipt.writerHash===e.controllerHash,'Unknown cannot become no-send');requests.delete(event.requestId);}
    if(event.event==='shutdown_ready')ready=event;
   }else if(row.kind==='command_sent'&&row.command?.command==='cpu_registration_ack'){const v=row.command;need(registered.get(v.operation)?.hash===v.registrationHash,'CPU ACK differs');acked.add(v.operation);}
   else if(row.kind==='command_sent'&&row.command?.command==='observed_ack'){const v=row.command;need(observed.get(v.requestId)?.hash===v.observedHash&&observed.get(v.requestId)?.event.providerId===v.providerId,'Provider ACK differs');observedAck.add(v.requestId);}
   else if(row.kind==='processes_reaped')reaped=true;else if(row.kind==='cpu_reconciliation')cleanup=row.receipts;
   else if(['failure','cleanup_failure'].includes(row.kind))throw Error('Failed process evidence');
  }
  const s=shutdown();need(ready?.snapshotHash===s.snapshotHash&&ready.durableOwnerVersion===s.durableOwnerVersion&&ready.runPk===runPk&&reaped&&!requests.size&&Array.isArray(cleanup)&&cleanup.length===registered.size&&acked.size===registered.size,'Incomplete shutdown process census');
  for(const [id]of registered)need(cleanup.some((r:any)=>r.operation===id&&r.containerAbsent===true&&r.clientReaped===true),'CPU cleanup missing');
  need(s.snapshot.rows.filter((x:any)=>x.sk.startsWith('CPU#')).every((x:any)=>registered.has(JSON.parse(x.entry).operation)),'Unregistered CPU in durable census');
  need(s.snapshot.rows.filter((x:any)=>x.sk.startsWith('RECOVERY#')).every((x:any)=>['completed_reaped','aborted_reaped'].includes(x.status)&&x.processExitProven===true),'Unreaped recovery');
  need(same(lineage,await lineageEvidence()),'Late predecessor evidence change');
  return{format:'qsb-common-reaped-evidence-v1',runPk,configHash,snapshotHash:s.snapshotHash,durableOwnerVersion:s.durableOwnerVersion,controllerHash:e.controllerHash,wrapperHash:e.wrapperHash,journalHash:hash(journal),receiptHash:hash(receiptBytes),processesReaped:true,cpuContainersAbsent:true,registeredRecoveryReaped:true,transportMode:'operational'};
 }
 return{readQuiescence,async readFinalDrain(expected){const lineage=await lineageEvidence(),s=shutdown();need(expected.runPk===runPk&&expected.configHash===configHash&&expected.snapshotHash===s.snapshotHash,'Drain request differs');const d=await drain.observe(store,s);need(same(lineage,await lineageEvidence()),'Late lineage during drain');return{format:'qsb-final-provider-drain-v1',runPk,configHash,snapshotHash:s.snapshotHash,observedAtMs:d.startedAt,endpoints:d.endpoints.map((x:any)=>({id:x.id,workersMin:x.workersMin as 0,workersMax:x.workersMax as 0,inQueue:x.queued as 0,inProgress:x.inProgress as 0})),providers:d.knownTerminals.map((x:any)=>({scope:x.scope.slice(11),intent:x.intent,id:x.provider,status:x.status}))};}};
}
