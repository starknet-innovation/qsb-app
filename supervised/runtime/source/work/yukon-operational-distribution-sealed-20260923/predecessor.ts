import{retirement,withRetiredEndpoints}from'../yukon-resource-session-locator-20260923/retirement';
import {readFileSync,lstatSync} from 'node:fs';import {join,dirname} from 'node:path';import {createHash} from 'node:crypto';import {readNoFollow} from '../read-nofollow';import {createEvidenceReaders,type Enrollment} from '../yukon-mainnet-cycling-runner-20260923/evidence-readers';import {validateEntry} from '../yukon-resource-session-locator-20260923/config';import type {CensusStore} from '../yukon-mainnet-cycling-runner-20260923/census-store';
const h=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
/** Only the adjacent fixed application source enrollment is admitted; no uploaded code/reader. */
export function loadPredecessor(store:CensusStore,key:string,directory:string,seen=new Set<string>(),retainedResources=false,expectedConfigHash?:string):any{
 if(!/^\/evidence\/[a-z0-9-]+$/.test(directory)||seen.has(directory)||seen.size>=256||lstatSync(directory).isSymbolicLink())throw Error('Invalid predecessor directory');seen.add(directory);
 const root=dirname(__filename),enrollment=JSON.parse(readFileSync(join(root,'enrollment.json'),'utf8'));
 for(const [file,hash]of Object.entries(enrollment.files)){if(!/^[a-z_.-]+$/.test(file)||h(readFileSync(join(root,file)))!==hash)throw Error('Fixed source differs');}
 const file=(name:string)=>{const bytes=readNoFollow(join(directory,name),'Linked predecessor artifact');if(name==='config.json'&&expectedConfigHash&&h(bytes)!==expectedConfigHash)throw Error('Exact external configuration bytes changed');return bytes.toString('utf8');};
 const config=validateEntry(JSON.parse(file('config.json')),true),shutdown=JSON.parse(file('shutdown-result.json'));
 const predecessors:Record<string,()=>Promise<any>>={};if(config.continuation||config.contextCycle){const older=loadPredecessor(store,key,(config.continuation??config.contextCycle).directory,seen,config.continuation?.retainedResources===true);Object.assign(predecessors,older.predecessors);predecessors['SUPERVISION#'+older.config.transport.blueprint.runId]=older.readers.readQuiescence;}
 const readers=createEvidenceReaders(store,config.transport,key,directory,{controllerHash:enrollment.files['controller.cjs'],wrapperHash:enrollment.files['supervisor.py'],sourceFiles:enrollment.files},predecessors);
 return{config,shutdown,readers:retainedResources?withRetiredEndpoints(readers,retirement(store,config.transport,shutdown,readers.readQuiescence)):readers,predecessors};
}
