import{afterInitialize}from'../yukon-resource-session-locator-20260923/entry-hooks';
import {loadPredecessor} from './predecessor';
import {status as readStatus} from '../yukon-mainnet-cycling-runner-20260923/status';
import {operationalTransports} from '../yukon-mainnet-cycling-runner-20260923/transport';
import {isDeepStrictEqual} from 'node:util';


/** Fixed operational entry. Private credential only on inherited fd3; no stored secret lookup. */
import {createHash} from 'node:crypto';import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync,readSync,fstatSync} from 'node:fs';import {dirname} from 'node:path';import {createInterface} from 'node:readline';
import {createServiceExecution} from '../yukon-resource-session-locator-20260923/execution';
import {publishProgress} from '../yukon-service-progress-20260923/progress';
import {DynamoCensusStore} from '../yukon-common-census-fence-20260923/census-store';
import {runOwnedCpu} from '../yukon-owned-runtime-env-20260923/runtime';

import {validateEntry} from '../yukon-resource-session-locator-20260923/config';
function save(path:string,v:any){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(v));fsyncSync(fd);}finally{closeSync(fd);}const d=openSync(dirname(path),'r');try{fsyncSync(d);}finally{closeSync(d);}}
function readCredential(){if(!fstatSync(3).isFIFO())throw Error('Private credential pipe required');const bytes=Buffer.alloc(4097);let n=0;try{while(n<bytes.length){const k=readSync(3,bytes,n,bytes.length-n,null);if(!k)break;n+=k;}}finally{closeSync(3);}if(n<1||n>4096)throw Error('Runtime credential missing or oversized');const key=bytes.subarray(0,n).toString('utf8');bytes.fill(0);if(/[\r\n]/.test(key))throw Error('Invalid credential');return key;}
const evidenceDirectory=process.argv[4];if(!/^\/evidence\/[a-z0-9-]+$/.test(evidenceDirectory)||!/^\/proc\/self\/fd\/[0-9]+$/.test(process.argv[2]))throw Error('Exact sealed config and evidence directory required');
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');const bytes=readFileSync(process.argv[2]);if(hash(bytes)!==process.argv[3])throw Error('Public config bytes differ');
const cfg=validateEntry(JSON.parse(bytes.toString()));const outerHash=hash(bytes);const transport=cfg.transport;
const b=transport.blueprint,configHash=hash(JSON.stringify(b)),runPk='SUPERVISION#'+b.runId;
const table=cfg.table;const store=new DynamoCensusStore(table);const pending=new Map<string,{hash:string,providerId?:string,resolve:()=>void,reject:(e:Error)=>void}>();
const starts=new Map<string,any>();
function emit(event:any){if(event.event==='request_started'){starts.set(event.requestId,structuredClone(event));}process.stdout.write(JSON.stringify({...event,outerConfigHash:outerHash})+'\n');}
function preserve(event:any){const line=JSON.stringify({...event,outerConfigHash:outerHash}),key=event.event==='cpu_registered'?'cpu:'+event.operation:'request:'+event.requestId;if(pending.has(key))throw Error('Duplicate pending acknowledgement');return new Promise<void>((resolve,reject)=>{pending.set(key,{hash:hash(line),providerId:event.providerId,resolve,reject});process.stdout.write(line+'\n');});}
const credential=readCredential();const transportStatus=operationalTransports(transport,credential);
let common:Awaited<ReturnType<typeof createServiceExecution>>;let resolveConstruction!:()=>void;const constructed=new Promise<void>(r=>resolveConstruction=r);
let busy=true,closed=false;async function failure(_e:any){emit({event:'protocol_failure',configHash,runPk,error:'Operation failed; preserve durable state'});process.exitCode=2;}
const rl=createInterface({input:process.stdin});rl.on('line',line=>{void(async()=>{const v=JSON.parse(line);if(v.command==='observed_ack'||v.command==='cpu_registration_ack'){const cpu=v.command==='cpu_registration_ack',key=cpu?'cpu:'+v.operation:'request:'+v.requestId,p=pending.get(key);if(!p||p.hash!==(cpu?v.registrationHash:v.observedHash)||(!cpu&&p.providerId!==v.providerId))throw Error('Acknowledgement differs');pending.delete(key);p.resolve();return;}
 if(v.command==='status'){if(busy||closed||pending.size)throw Error('Status unavailable');busy=true;try{const state=await readStatus(store,b,transportStatus.drain);emit({event:'state_result',configHash,runPk,state});}finally{busy=false;}return;}
 if(v.command==='reconcile_not_sent'){if(busy||closed)throw Error('Operation not settled');const original=starts.get(v.pending?.requestId);if(!original||JSON.stringify(original)!==JSON.stringify(v.pending))throw Error('Pending source bytes differ');const receipt=await common.reconcileNotSent(original,hash(readFileSync(__filename)));emit({event:'not_sent_reconciled',configHash,runPk,requestId:original.requestId,receipt});return;}
 if(v.command==='stop_dispatch'){await constructed;await common.stop();return;}
 if(v.command==='shutdown'){if(busy||closed||pending.size)throw Error('Outstanding operation/receipt');closed=true;const result=await common.shutdown();save(evidenceDirectory+'/shutdown-result.json',result);rl.close();process.stdin.pause();return;}
 if(v.command!=='operate'||!['reserve','submit','recover-id','poll','run','reconcile','extend'].includes(v.operation)||busy||closed)throw Error('Unsupported or concurrent operation');busy=true;let resultEvent:any;try{let result;if(v.operation==='extend')result=await common.extend(v.intent);else result=await common.operation(v.operation,v.intent);await publishProgress(store,cfg.service.owner,cfg.service.request.jobId);resultEvent={event:'operation_result',configHash,runPk,result:result??null};}catch(e:any){resultEvent={event:'operation_result',configHash,runPk,error:'Operation failed; preserve durable state'};}finally{busy=false;}emit(resultEvent);
})().catch(failure);});
async function main(){const prior=(cfg.continuation??cfg.contextCycle)?loadPredecessor(store,credential,(cfg.continuation??cfg.contextCycle).directory,new Set<string>(),cfg.continuation?.retainedResources===true):undefined;if(prior&&(!isDeepStrictEqual(prior.config.service.request,cfg.service.request)||prior.config.service.owner!==cfg.service.owner||prior.config.service.session+1!==cfg.service.session||prior.config.table!==cfg.table))throw Error('Service predecessor differs');common=await createServiceExecution(store,cfg.service.owner,cfg.service.request,transport,credential,emit,preserve,preserve,cfg.service.session,prior?.config.transport,cfg.contextCycle?'context_cycle':cfg.continuation?.retainedResources?'resource_session':'continuation');const initializing=prior?common.adopt(prior.shutdown,prior.readers):common.initialize();resolveConstruction();await initializing;if(!prior)await afterInitialize(store,null,cfg);await publishProgress(store,cfg.service.owner,cfg.service.request.jobId);busy=false;emit({event:'common_ready',configHash,runPk});}
main().catch(failure);
