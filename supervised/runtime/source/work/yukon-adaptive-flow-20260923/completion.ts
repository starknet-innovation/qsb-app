import type {Store,Row} from '../../outputs/qsb-vault/server/store';
/** Finish only the existing linked, drained round2 transition; no imported solved-state authority. */
export async function terminalParentWrites(store:Store,parentScope:string,childScope:string,owner:string,revision:number,runPk:string,configHash:string){
 const c=await store.get('VALIDATION#'+childScope,'SCOPE');
 if(!c||c.phase!=='awaiting_authorization')return [];
 const p=await store.get('VALIDATION#'+parentScope,'SCOPE');
 if(!p||p.phase!=='subset_running'||p.childScope!==childScope||c.parentScope!==parentScope||c.stage!=='round2'||c.dispatchAuthorized!==true||typeof p.pinReceiptHash!=='string'||p.pinReceiptHash!==c.pinReceiptHash||[p,c].some(r=>r.owner!==owner||r.revision!==revision||r.identitySchema!=='provider-index-v1'||r.identityConflict||r.dispatchClosed||r.supervisedRun!==runPk||r.supervisedConfigHash!==configHash))throw Error('Terminal child linkage changed');
 const solutions=c.solutions as Record<string,number[]>;
 if(!solutions||!['round1','round2'].every(stage=>Array.isArray(solutions[stage])&&solutions[stage].length===9&&new Set(solutions[stage]).size===9&&solutions[stage].every(i=>Number.isInteger(i)&&i>=0&&i<150)))throw Error('Terminal solutions missing');
 return [{row:{...p,version:p.version+1,phase:'subset_prepared'},expected:p.version},{row:{...c,version:c.version+1},expected:c.version}];
}
