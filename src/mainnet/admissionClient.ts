import {validateSolvedState} from './solvedContract';
import {fingerprint} from '../lib/provenance';
import type {TrustedAdmissionReader} from './consumer';
/** Same-origin authenticated reader. Token supplier is application session state, never imported public JSON. */
export function currentAdmissionClient(jobId:string,requestId:string,sessionToken:()=>string,fetcher:typeof fetch=fetch):TrustedAdmissionReader{
 if(!/^[0-9a-f-]{36}$/.test(jobId)||!/^[0-9a-f-]{36}$/.test(requestId))throw Error('Invalid local job/request binding');
 return async id=>{if(id!==requestId)throw Error('Request differs');const token=sessionToken();if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('Sign in required');
  const response=await fetcher('/api/jobs/'+encodeURIComponent(jobId)+'/mainnet-solved-state',{method:'GET',headers:{Authorization:'Bearer '+token},cache:'no-store',credentials:'same-origin',redirect:'error'});
  if(!response.ok||sessionToken()!==token)throw Error('Current admission unavailable');const result=await response.json();if(sessionToken()!==token)throw Error('Session changed');
  if(!result||Object.keys(result).sort().join(',')!=='bundle,mainnetAuthorized,record'||result.mainnetAuthorized!==false||!result.record||Object.keys(result.record).join(',')!=='bundleSha256')throw Error('Invalid admission response');const bundle=validateSolvedState(result.bundle);if(bundle.request.id!==requestId||bundle.request.manifest.idempotencyKey!==jobId||fingerprint(bundle)!==result.record.bundleSha256)throw Error('Admission digest differs');return{bundle,record:{bundleSha256:result.record.bundleSha256},mainnetAuthorized:false};
 };
}
