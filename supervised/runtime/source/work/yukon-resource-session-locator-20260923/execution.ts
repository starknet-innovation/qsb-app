import{readResourceGrant}from'./resource-grant';
import {readContextGrant} from './context';
import {readGrant} from './sessions';
import {signingReservations} from '../yukon-service-solved-completion-20260923/reservations';
import {enrolledMainnet} from '../yukon-mainnet-service-enrollment-20260923/capability';
import {fingerprint} from '../../outputs/qsb-vault/src/lib/provenance';
import {routeStoredJob} from '../yukon-app-routing-20260923/routing';
import {reservationAuthority} from '../yukon-canonical-reservations-20260923/reservations';
import {type LaunchRequest} from '../yukon-mainnet-service-enrollment-20260923/dispatch';
import type {CensusStore} from '../yukon-mainnet-cycling-runner-20260923/census-store';
import {validateConfig,type Config} from '../yukon-mainnet-cycling-runner-20260923/transport';
import {createOperationalSigningCommon} from '../yukon-mainnet-cycling-runner-20260923/operational-export';
export function controllerIds(invocationId:string){if(!/^[a-f0-9]{64}$/.test(invocationId))throw Error('Invalid invocation');return {runId:'supervised-'+invocationId,parent:'isolated-yukon-pin-'+invocationId,scope:'isolated-yukon-subset-'+invocationId};}
/** Service execution boundary. New operations/transport starts require current app authority; late results and cleanup remain writable. */
export async function executionBoundary(base:CensusStore,owner:string,request:LaunchRequest,config:Config,session=0,previous?:Config,mode:'continuation'|'context_cycle'|'resource_session'='continuation'){
 const r=structuredClone(request),cfg=validateConfig(config),priorConfig=previous?validateConfig(previous):undefined,ids=controllerIds(r.invocationId),pk='OWNER#'+owner;
 
 if(!Number.isSafeInteger(session)||session<0||session>10000||cfg.blueprint.network!=='mainnet'||(session===0)!==!priorConfig)throw Error('Explicit mainnet service session required');
 if(!['continuation','context_cycle','resource_session'].includes(mode)||(mode==='context_cycle'&&!session))throw Error('Explicit context transition required');if(priorConfig){ids.parent=mode==='context_cycle'?'isolated-yukon-pin-'+r.invocationId+'-context-'+session:priorConfig.blueprint.pin.parent;ids.scope=mode==='context_cycle'?'isolated-yukon-subset-'+r.invocationId+'-context-'+session:priorConfig.blueprint.subset.scope;}
 const baseRun=ids.runId;ids.runId=session?baseRun+'-session-'+session:baseRun;const previousRun=session?'SUPERVISION#'+(session===1?baseRun:baseRun+'-session-'+(session-1)):undefined;
 if(priorConfig&&(priorConfig.blueprint.runId!==previousRun!.slice(12)||priorConfig.blueprint.network!=='mainnet'||(['pin','subset'] as const).some(k=>priorConfig.blueprint[k].maxSubmissions!==cfg.blueprint[k].maxSubmissions)))throw Error('Predecessor session or cumulative ceiling changed');
 if(owner!==r.owner||cfg.blueprint.runId!==ids.runId||cfg.blueprint.pin.parent!==ids.parent||cfg.blueprint.subset.parent!==ids.parent||cfg.blueprint.subset.scope!==ids.scope||cfg.blueprint.pin.owner!==owner||cfg.blueprint.subset.owner!==owner||cfg.blueprint.pin.revision!==1||cfg.blueprint.subset.revision!==1)throw Error('Controller identity differs');
 const runPk='SUPERVISION#'+ids.runId,scopePk='VALIDATION#'+ids.parent,bindingKey='V5_CONTROLLER#'+r.jobId,configHash=fingerprint(cfg);
 async function reads(initial:boolean){
  const job=await base.get(pk,'JOB#'+r.jobId),admission=await base.get(pk,'V5_ADMISSION#'+r.jobId),invocation=await base.get(pk,'V5_INVOCATION#'+r.jobId),authority=await reservationAuthority(base);
  if(!job||!admission||!invocation)throw Error('Service admission required');const j=job.job as any;
  if(admission.status!=='admitted'||admission.requestHash!==fingerprint(r)||admission.executionHash!==r.executionHash||admission.jobVersion!==r.jobRowVersion+1||j.owner!==owner||j.id!==r.jobId||j.revision!==0||j.status!==(initial?'starting':'bootstrapping')||j.reservationAuthorityHash!==fingerprint(authority))throw Error('Paused or changed admission');
  if(!initial&&j.controllerRun!==(enrolled?runPk:(previousRun??runPk)))throw Error('Controller ownership changed');
  if(initial&&job.version!==admission.jobVersion)throw Error('Admission job version changed');
  if(typeof invocation.request!=='string'||fingerprint(JSON.parse(invocation.request))!==fingerprint(r)||invocation.executionHash!==r.executionHash||invocation.invocationId!==r.invocationId||invocation.owner!==owner||invocation.jobId!==r.jobId||!['accepted','unknown','dispatching'].includes(String(invocation.status)))throw Error('Invocation changed');
  const vault=await base.get(pk,'VAULT#'+j.vaultId);if(!vault)throw Error('Vault missing');const route=routeStoredJob(j,vault.vault as any);
  if(route.target!=='supervised-service'||route.execution.network!=='mainnet'||fingerprint(route.execution)!==r.executionHash)throw Error('Execution changed');
  const reserved=await signingReservations(base,owner,j);const enrollment=await enrolledMainnet(base,owner,j,invocation,vault.vault);if((session===0&&fingerprint(enrollment.config)!==fingerprint(cfg))||admission.capabilityHash!==invocation.capabilityHash||admission.runtimeConfigHash!==invocation.runtimeConfigHash||admission.mainnetRequestHash!==j.mainnetRequestHash)throw Error('Mainnet controller enrollment differs');
  const grant=session?await (mode==='context_cycle'?readContextGrant:mode==='resource_session'?readResourceGrant:readGrant)(base,owner,r,session,cfg,priorConfig!,enrollment.capability):undefined;
  return {job,j,admission,invocation,authority,vault,grant,capability:enrollment.capability,reservations:reserved.reservations,context:{publicStateJson:(vault.vault as any).publicStateJson,manifest:structuredClone(j.manifest),network:'mainnet'}};
 }
 let enrolled=false;const initial=await reads(session===0),context=structuredClone(initial.context);
 const store:CensusStore={get:base.get.bind(base),list:base.list.bind(base),all:base.all.bind(base),delete:base.delete.bind(base),put:(row,expected)=>store.atomicPut([{row,expected}]),atomicPut:async writes=>{
  writes=structuredClone(writes);
  const start=writes.some(w=>w.row.pk===runPk&&w.row.sk==='OWNER'&&w.expected===undefined);
  const cpuStart=writes.some(w=>w.row.pk===runPk&&w.row.sk.startsWith('CPU#')&&w.row.status==='registered'&&w.expected===undefined);
  const completion=writes.some(w=>w.row.pk===scopePk&&w.row.sk==='SCOPE'&&w.row.phase==='pinning_searching')&&writes.some(w=>w.row.pk===runPk&&w.row.sk.startsWith('OPERATION#')&&w.row.status==='completed');
  const operationStart=writes.some(w=>w.row.pk===runPk&&w.row.sk.startsWith('OPERATION#')&&w.row.status==='running'&&w.expected===undefined);
  const transportStart=writes.some(w=>w.row.pk===runPk&&w.row.sk.startsWith('REQUEST#')&&w.row.status==='started'&&w.expected===undefined);
  const retiring=mode==='context_cycle'&&writes.some(w=>w.row.pk===previousRun&&w.row.sk==='OWNER'&&w.row.status==='context_retired');
  if(!start&&!cpuStart&&!completion&&!operationStart&&!transportStart&&!retiring)return base.atomicPut(writes);
  const x=await reads(start&&session===0);if(fingerprint(x.context)!==fingerprint(context))throw Error('Public context changed');
  const prior=await base.get(pk,bindingKey);
  if(retiring){const receipt=writes.find(w=>w.row.pk===previousRun&&w.row.sk==='CONTEXT_RETIREMENT')?.row;if(writes.length!==5||!receipt||!x.grant||!prior||prior.session!==session-1||prior.runPk!==previousRun||prior.configHash!==fingerprint(priorConfig)||prior.requestHash!==fingerprint(r))throw Error('Unbound context retirement');const {pk:_,sk:__,version:___,proofHash,...body}=receipt;if(fingerprint(body)!==x.grant.eligibilityHash||fingerprint(x.grant.stableReceipt)!==x.grant.eligibilityHash)throw Error('Retirement differs from complete domain grant');await base.atomicPut([...writes,...[prior,x.job,x.admission,x.invocation,x.authority,x.vault,x.capability,...x.reservations,x.grant].map(row=>({row,expected:row.version}))]);return;}
  if(start){if(enrolled)throw Error('Controller already bound');if(session===0){if(prior)throw Error('Controller already bound');if(!writes.some(w=>w.row.pk===scopePk&&w.row.phase==='bootstrap'&&w.expected===undefined))throw Error('Missing bootstrap scope');}else{if(!prior||prior.session!==session-1||prior.runPk!==previousRun||prior.configHash!==fingerprint(priorConfig)||prior.requestHash!==fingerprint(r)||prior.contextHash!==fingerprint(context))throw Error('Predecessor service binding changed');if(!writes.some(w=>w.row.pk===previousRun&&w.row.sk==='OWNER'&&w.row.status==='superseded'&&w.row.successor===runPk)||!writes.some(w=>w.row.pk===scopePk&&w.row.supervisedRun===runPk&&w.expected!==undefined))throw Error('Missing settled owner handoff');}}
  else if(!prior||prior.runPk!==runPk||prior.configHash!==configHash||prior.requestHash!==fingerprint(r))throw Error('Controller binding changed');
  const binding=start?{kind:mode,pk,sk:bindingKey,version:prior?prior.version+1:0,session,runPk,scopePk,configHash,requestHash:fingerprint(r),executionHash:r.executionHash,contextHash:fingerprint(context),...(previousRun?{predecessorRun:previousRun}:{})}:prior!;
  await base.atomicPut([...writes,...(start&&session>0?[{row:{...prior!,sk:'V5_CONTROLLER_SESSION#'+r.jobId+'#'+(session-1),version:0}}]:[]),{row:binding,...(prior?{expected:prior.version}:{})},{row:{...x.job,version:x.job.version+1,job:{...x.j,status:'bootstrapping',controllerRun:runPk}},expected:x.job.version},...([x.admission,x.invocation,x.authority,x.vault,x.capability,...x.reservations,...(x.grant?[x.grant]:[])].map(row=>({row,expected:row.version})))]);enrolled=true;
 }};
 return {store,originalRequest:structuredClone(initial.j.mainnetRequest),context:structuredClone(context),config:structuredClone(cfg),binding:{runPk,scopePk,configHash}};
}
export async function createServiceExecution(base:CensusStore,owner:string,r:LaunchRequest,config:Config,key:string,emit:(e:any)=>void,preserve:(e:any)=>Promise<void>,preserveCpu:(e:any)=>Promise<void>,session=0,previous?:Config,mode:'continuation'|'context_cycle'|'resource_session'='continuation'){
 previous=previous?structuredClone(previous):undefined;const b=await executionBoundary(base,owner,r,config,session,previous,mode),common=createOperationalSigningCommon(b.store,b.config,key,emit,preserve,preserveCpu);
 return {prepareSolvedState:()=>common.prepareSolvedState(structuredClone(b.originalRequest)),initialize:()=>common.initialize(structuredClone(b.context)),adopt:(shutdown:any,readers:Parameters<typeof common.adopt>[2])=>{if(!previous||!session)throw Error('No predecessor enrolled');return mode==='context_cycle'?common.cycle(previous.blueprint,shutdown,readers):common.adopt(previous.blueprint,shutdown,readers);},reconcileNotSent:(pending:any,hash:string)=>common.reconcileNotSent(pending,hash),operation:(op:string,intent?:string)=>common.operation(op,intent),extend:(winner:string)=>common.extend(winner),stop:()=>common.stop(),shutdown:()=>common.shutdown(),binding:b.binding};
}
