import {fingerprint} from '../../outputs/qsb-vault/src/lib/provenance';
import type {Store,Row} from '../../outputs/qsb-vault/server/store';
/** Observational projection only. Never changes app status/revision or grants execution/signing authority. */
export async function publishProgress(store:Store,owner:string,jobId:string){
 const pk='OWNER#'+owner,job=await store.get(pk,'JOB#'+jobId),binding=await store.get(pk,'V5_CONTROLLER#'+jobId);
 if(!job||!binding||!owner)throw Error('Missing service job binding');const j=job.job as any;
 if(j.owner!==owner||j.id!==jobId||j.controllerRun!==binding.runPk||typeof binding.runPk!=='string'||typeof binding.scopePk!=='string')throw Error('Job controller differs');
 const lifetime=await store.get(binding.runPk,'OWNER'),parent=await store.get(binding.scopePk,'SCOPE');
 if(!lifetime||!parent||lifetime.owner!==owner||parent.owner!==owner||parent.supervisedRun!==binding.runPk||parent.supervisedConfigHash!==lifetime.configHash||parent.revision!==lifetime.revision||parent.pk!=='VALIDATION#'+lifetime.parent)throw Error('Unbound controller progress');
 const child=typeof parent.childScope==='string'?await store.get('VALIDATION#'+parent.childScope,'SCOPE'):undefined;
 if(parent.childScope&&!child)throw Error('Linked child missing');
 if(child&&(child.owner!==owner||child.parentScope!==lifetime.parent||child.supervisedRun!==binding.runPk||child.supervisedConfigHash!==lifetime.configHash||child.revision!==lifetime.revision))throw Error('Foreign child progress');
 const source=[lifetime,parent,...(child?[child]:[])];
 const summary=(s:Row)=>({version:s.version,phase:s.phase??null,stage:s.stage??null,dispatchClosed:s.dispatchClosed===true,identityConflict:s.identityConflict===true});
 const progress={format:'qsb-service-progress-v1',runPk:binding.runPk,sourceHash:fingerprint(source),lifetime:{version:lifetime.version,status:lifetime.status,activeOperation:lifetime.activeOperation??null},pin:summary(parent),subset:child?summary(child):null,executionAuthorized:false,signingAuthorized:false};
 // Touch every source row under version conditions so a concurrent pause/advance cannot publish stale progress.
 await store.atomicPut([{row:{...job,version:job.version+1,job:{...j,executionProgress:progress}},expected:job.version},...[binding,...source].map(row=>({row,expected:row.version}))]);
 return structuredClone(progress);
}
