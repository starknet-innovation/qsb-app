import type {Cpu} from './runtime-api';
/** One explicit operation per invocation; no hidden submission/retry loop. */
import type {Store} from '../../outputs/qsb-vault/server/store';
import {Orchestrator} from './orchestrator';
import {Drain} from '../yukon-indexed-controller-20260923/drain';
import {GuardedIntents} from '../yukon-indexed-controller-20260923/guarded-intents';
import {nextAction} from '../yukon-indexed-controller-20260923/scheduler';
import {ProviderIO} from '../yukon-indexed-controller-20260923/provider-io';
import {validateExecution,type Observation} from '../yukon-indexed-controller-20260923/execution-gate';
export class Controller {
 private coordinator:Orchestrator;
 private drain:Drain;
 private intents:GuardedIntents;
 constructor(private store:Store,private scope:string,private owner:string,private revision:number,private provider:ProviderIO,private observe:()=>Promise<Observation>,private cpu:Cpu){
  this.coordinator=new Orchestrator(store,scope,owner,revision,provider.endpoint,cpu);
  this.drain=new Drain(store,scope,owner,revision);
  this.intents=new GuardedIntents(store,scope,owner,revision);
 }
 async initialize(event:unknown,budget:{maxSubmissions:number;deadlineMs:number}){await this.coordinator.initialize(event);await this.coordinator.configureBudget(budget.maxSubmissions,budget.deadlineMs);}
 recoverProviderId(intent:string){return this.intents.recover(intent);}
 plan(){return nextAction(this.store,this.scope,this.owner,this.revision);}
 reserve(range:string,event:unknown){return this.coordinator.reserve(range,event);}
 submit(intent:string){return this.coordinator.submit(intent,async(endpoint,event)=>{const state=await this.store.get('VALIDATION#'+this.scope,'SCOPE');const budget=state?.budget as {deadlineMs:number}|undefined;if(!budget)throw Error('Missing budget');validateExecution(endpoint,budget.deadlineMs,await this.observe());await this.intents.authorizeDispatch(intent);return this.provider.send(endpoint,event);});}
 poll(intent:string){return this.coordinator.poll(intent,(endpoint,id)=>this.provider.read(endpoint,id));}
 retireUnsubmitted(intent:string){return this.drain.retireReserved(intent);}
 advance(){return this.drain.advance();}
}
