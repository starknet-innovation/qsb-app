import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {canonical,solverRelease} from '../../outputs/qsb-vault/src/lib/provenance';
const release=solverRelease('qsb-config-a-ranked-v2-2791ed0');
for(const name of ['worker/handler.py','worker/search_ranges.py']){const bytes=readFileSync(new URL('../../outputs/qsb-vault/'+name,import.meta.url));if(createHash('sha256').update(bytes).digest('hex')!==(release.sourceHashes as Record<string,string>)[name])throw Error('Archived worker source mismatch');}
export function pinRange(attempt:number){if(!Number.isSafeInteger(attempt)||attempt<0||attempt>=2**27)throw Error('Invalid pin attempt');const offset=BigInt(attempt)*16n;return {version:'ranked-v2',start:String(offset*1244600000n),count:19913600000,sequence:2147483648+attempt*16,sequenceCount:16,locktime:500000000};}
export function pinRequest(attempt:number,manifestHash:string,parameters:{parameterBase64:string;parameterSha256:string}){
 pinRange(attempt);if(!/^[a-f0-9]{64}$/.test(manifestHash)||typeof parameters.parameterBase64!=='string'||typeof parameters.parameterSha256!=='string')throw Error('Invalid public request');
 const bytes=Buffer.from(parameters.parameterBase64,'base64');if(bytes.length<64||bytes.length>100000||bytes.toString('base64')!==parameters.parameterBase64||createHash('sha256').update(bytes).digest('hex')!==parameters.parameterSha256)throw Error('Invalid public parameters');
 return {protocol:release.protocol,stage:'pinning',attempt,manifestHash,kernelCommit:release.kernelCommit,searchVersion:release.searchVersion,parameterBase64:parameters.parameterBase64,parameterSha256:parameters.parameterSha256};
}
export function pinResult(request:ReturnType<typeof pinRequest>,output:any){
 const rebuilt=pinRequest(request.attempt,request.manifestHash,request);if(canonical(request)!==canonical(rebuilt))throw Error('Request contract mismatch');
 if(!output||Object.keys(output).sort().join(',')!=='attempt,candidates,checkpoint,elapsedSeconds,kernelCommit,manifestHash,stage,status,verified,workRange'||output.status!=='completed'||output.checkpoint!=='range-complete'||output.verified!==false||output.stage!=='pinning'||output.manifestHash!==request.manifestHash||output.kernelCommit!==request.kernelCommit||output.attempt!==request.attempt||typeof output.elapsedSeconds!=='number'||!Number.isFinite(output.elapsedSeconds)||output.elapsedSeconds<0||canonical(output.workRange)!==canonical(pinRange(request.attempt)))throw Error('Incomplete or mismatched pin result');
 if(!Array.isArray(output.candidates)||output.candidates.length>32)throw Error('Invalid candidate files');
 const unit=pinRange(request.attempt),pins:{sequence:number;locktime:number;record:string}[]=[];
 for(const file of output.candidates){if(typeof file!=='string'||Buffer.byteLength(file)>=16384)throw Error('Invalid candidate file');const records=file.split(/(?=^sequence=)/m).filter((x:string)=>x.trim());if(!records.length)throw Error('Empty candidate file');
  for(const record of records){const seq=[...record.matchAll(/^sequence=(\d+)\r?$/gm)],lt=[...record.matchAll(/^locktime=(\d+)\r?$/gm)];if(seq.length!==1||lt.length!==1)throw Error('Ambiguous candidate');const sequence=Number(seq[0][1]),locktime=Number(lt[0][1]);if(!Number.isSafeInteger(sequence)||sequence<unit.sequence||sequence>=unit.sequence+16||!Number.isSafeInteger(locktime)||locktime<500000000||locktime>=1744600000)throw Error('Candidate outside range');pins.push({sequence,locktime,record});}
 }
 return {kind:pins.length?'candidates':'no_hits',pins,range:unit,cpuVerificationRequired:true,rangeCreditAuthorized:false};
}
