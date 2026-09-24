import type {Store,Row} from '../../outputs/qsb-vault/server/store';
import {fingerprint} from '../../outputs/qsb-vault/src/lib/provenance';
import {reservationAuthority,canonicalOutpointKey} from '../yukon-canonical-reservations-20260923/reservations';
export async function signingReservations(store:Store,owner:string,job:any){
 const authority=await reservationAuthority(store);if(job.reservationAuthorityHash!==fingerprint(authority))throw Error('Reservation authority changed');
 const rows:Row[]=[];for(const field of ['funding','helper']){const point=job.manifest[field],key=canonicalOutpointKey(point.txid,point.vout),row=await store.get(key,'RESERVATION');
  if(!row||row.owner!==owner||row.jobId!==job.id||Object.keys(row).sort().join(',')!=='jobId,owner,pk,sk,version'||row.pk!==key||row.sk!=='RESERVATION'||!Number.isSafeInteger(row.version)||row.version<0)throw Error('Exact input reservation missing or changed');rows.push(row);}
 if(rows[0].pk===rows[1].pk)throw Error('Duplicate input reservation');return {authority,reservations:rows};
}
