import type {Store,Row} from '../../outputs/qsb-vault/server/store';
import {canonicalOutpointKey} from '../yukon-canonical-reservations-20260923/reservations';
const AUTHORITY_PK='SYSTEM#RESERVATION_AUTHORITY',AUTHORITY_SK='GENERATION';
/** Legacy writers stopped and the migration finished map to exclusion plus acceptance. */
export async function generationAuthority(store:Store):Promise<Row>{
 const row=await store.get(AUTHORITY_PK,AUTHORITY_SK);
 if(!row||row.legacyExcluded!==true||row.canonicalAccepting!==true||!Number.isSafeInteger(row.generation)||Number(row.generation)<1)throw Error('Canonical reservation authority not enrolled; legacy migration/writer exclusion required');
 return row;
}
export async function signingReservations(store:Store,owner:string,job:any){
 const authority=await generationAuthority(store);if(job.reservationAuthorityGeneration!==authority.generation)throw Error('Reservation authority changed');
 const rows:Row[]=[];for(const field of ['funding','helper']){const point=job.manifest[field],key=canonicalOutpointKey(point.txid,point.vout),row=await store.get(key,'RESERVATION');
  if(!row||row.owner!==owner||row.jobId!==job.id||Object.keys(row).sort().join(',')!=='authorityGeneration,jobId,owner,pk,sk,version'||row.authorityGeneration!==authority.generation||row.pk!==key||row.sk!=='RESERVATION'||!Number.isSafeInteger(row.version)||row.version<0)throw Error('Exact input reservation missing or changed');rows.push(row);}
 if(rows[0].pk===rows[1].pk)throw Error('Duplicate input reservation');return {authority,reservations:rows};
}
