import {disablePinnedEndpoint} from '../yukon-pin-disable-20260923/disable.mjs';
/** Fixed operational composition. Construction alone performs no API call or resource mutation. */
import type {CensusStore} from './census-store';import {createFixedCommon} from './fixed-common';
import {operationalTransports,type Config} from './transport';
import {createEvidenceReaders,type Enrollment} from './evidence-readers';import {publishSolvedState,admitCurrentSolvedState,type ReapedEvidence} from './publication';
export function createOperationalSigningCommon(store:CensusStore,config:Config,key:string,emit:(e:any)=>void,preserve:(e:any)=>Promise<void>,preserveCpu:(e:any)=>Promise<void>){
 const t=operationalTransports(config,key);return createFixedCommon(store,t.config.blueprint,t.pin,t.subset,t.observePin,t.observeSubset,t.drain,emit,preserve,preserveCpu,()=>disablePinnedEndpoint(t.config.pin,key));
}
/** Enrollment/root must be supplied by the reviewed owning application, never by request/result JSON. */
export function createOperationalExportAdmission(store:CensusStore,config:Config,key:string,ownedDirectory:string,reviewedEnrollment:Enrollment,predecessors:Record<string,()=>Promise<ReapedEvidence>>={}){
 const t=operationalTransports(config,key),readers=createEvidenceReaders(store,t.config,key,ownedDirectory,reviewedEnrollment,predecessors);
 return {publish:(requestId:string)=>publishSolvedState(store,t.config.blueprint,requestId,readers),admit:(requestId:string)=>admitCurrentSolvedState(store,t.config.blueprint,requestId,readers)};
}
