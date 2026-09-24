/** Operational source path: one fixed owned registry, no caller-selected CPU callback or executable. */
import type {CensusStore} from './census-store';
import {ProviderIO as PinProvider} from '../yukon-v4-controller-20260923/provider-io';
import {ProviderIO as SubsetProvider} from '../yukon-indexed-controller-20260923/provider-io';
import {runOwnedCpu} from '../yukon-owned-runtime-20260923/runtime';
import {CommonLifetime,type Blueprint,type Drain} from './common';
export function createFixedCommon(store:CensusStore,blueprint:Blueprint,pinProvider:PinProvider,subsetProvider:SubsetProvider,observePin:()=>Promise<any>,observeSubset:()=>Promise<any>,drain:()=>Promise<Drain>,emit:(event:any)=>void,preserve:(event:any)=>Promise<void>,preserveCpu:(event:any)=>Promise<void>){
 return new CommonLifetime(store,blueprint,pinProvider,subsetProvider,observePin,observeSubset,drain,emit,preserve,runOwnedCpu,preserveCpu);
}
