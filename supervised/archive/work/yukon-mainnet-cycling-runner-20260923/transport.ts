import {MANIFEST as PIN} from '../yukon-pin-preflight-20260923/execution-gate';
import {MANIFEST as SUBSET} from '../yukon-indexed-controller-20260923/execution-gate';
const REPO='UNENROLLED_REGISTRY/qsb-vault-worker';
const forbidden=['historicalendpointone','historicalendpointtwo'];
export type Config={format:'qsb-common-operational-v1';blueprint:any;pin:{id:string;createdAt:string;image:string;socket:string};subset:{id:string;createdAt:string;image:string;socket:string}};
const exact=(x:any,keys:string[])=>{if(!x||Object.keys(x).sort().join(',')!==keys.sort().join(','))throw Error('Unexpected configuration fields');};
export function validateConfig(input:Config){
 const c=structuredClone(input);exact(c,['format','blueprint','pin','subset']);if(!['regtest','mainnet'].includes(c.blueprint?.network)||c.format!=='qsb-common-operational-v1'||c.blueprint?.format!=='qsb-common-lifetime-v1')throw Error('Unexpected format');
 for(const [stage,digest] of [['pin',PIN],['subset',SUBSET]] as const){const cutoff=c.blueprint[stage].submissionCutoffMs;if(!Number.isSafeInteger(cutoff)||cutoff<0||cutoff>c.blueprint[stage].deadlineMs)throw Error('Invalid enrolled cutoff');const x=c[stage];exact(x,['id','createdAt','image','socket']);if(!/^[a-z0-9]+$/.test(x.id)||forbidden.includes(x.id)||x.id!==c.blueprint[stage].endpoint||!Number.isFinite(Date.parse(x.createdAt))||x.image!==REPO+'@'+digest||!/^\/[a-zA-Z0-9_./-]+$/.test(x.socket)||x.socket.includes('/../'))throw Error('Endpoint, image or watchdog binding differs');}
 if(c.pin.id===c.subset.id)throw Error('Distinct stage endpoints required');return c;
}
