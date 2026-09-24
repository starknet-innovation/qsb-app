/** Independent per-endpoint cleanup owner. Never creates resources or submits work. */
import net from 'node:net';
import {performance} from 'node:perf_hooks';
import {chmodSync,openSync,writeFileSync,fsyncSync,closeSync,lstatSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';
export function validateEnrollment(c,now=Date.now()) {
 if(!c||Object.keys(c).sort().join(',')!=='createdAt,deadlineMs,endpoint,format,receipt,socket'||c.format!=='qsb-watchdog-enrollment-v1'||!/^[a-z0-9]{8,32}$/.test(c.endpoint)||!Number.isSafeInteger(c.deadlineMs))throw Error('Invalid watchdog enrollment');
 const created=Date.parse(c.createdAt);
 // Every enrollment is bounded by actual creation identity. Old proof endpoints cannot qualify.
 if(!Number.isFinite(created)||created>now+5000||c.deadlineMs<=created||c.deadlineMs>created+1800000)throw Error('Invalid creation/deadline binding');
 if(c.socket!=='/run/qsb-watchdogs/'+c.endpoint+'.sock'||c.receipt!=='/evidence/watchdog-'+c.endpoint+'.json')throw Error('Invalid watchdog paths');
 return structuredClone(c);
}
export async function watch(input,api,{onReady=()=>{}}={}) {
 const c=validateEnrollment(input),start=performance.now(),duration=Math.max(0,c.deadlineMs-Date.now());
 let stopping=false,timer,settle;
 const finished=new Promise(r=>settle=r);
 const server=net.createServer(peer=>{let bytes=0,text='';peer.setTimeout(1000,()=>peer.destroy());peer.on('error',()=>{});peer.on('data',chunk=>{
  bytes+=chunk.length;if(bytes>1024)return peer.destroy();text+=chunk.toString('utf8');if(!text.includes('\n'))return;
  try{const q=JSON.parse(text);if(Object.keys(q).join(',')!=='nonce'||!/^([a-f0-9]{32})$/.test(q.nonce))throw Error();peer.end(JSON.stringify({nonce:q.nonce,endpoint:c.endpoint,deadlineMs:c.deadlineMs,pid:process.pid,live:!stopping&&Date.now()<c.deadlineMs})+'\n');}catch{peer.destroy();}
 });});
 const cleanup=async()=>{
  if(stopping)return finished;stopping=true;clearInterval(timer);server.close();let absent=false,attempts=0;
  for(;attempts<3&&!absent;attempts++){
   try{
    const before=await api.inspect(c.endpoint);
    if(before){if(before.id!==c.endpoint||before.createdAt!==c.createdAt)throw Error('Creation identity changed');await api.remove(c.endpoint);}
    absent=(await api.inspect(c.endpoint))===null;
   }catch{/* Unknown is never absence. Only idempotent cleanup is retried. */}
  }
  const result={endpoint:c.endpoint,createdAt:c.createdAt,deadlineMs:c.deadlineMs,absent,attempts,providerDrainVerified:false,rangeCredit:false};
  try{const fd=openSync(c.receipt,'wx',0o600);try{writeFileSync(fd,JSON.stringify(result)+'\n');fsyncSync(fd);}finally{closeSync(fd);}const dir=openSync(dirname(c.receipt),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
  catch{result.absent=false;result.receiptUnavailable=true;}
  process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);settle(result);return result;
 };
 const stop=()=>{void cleanup();};
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.socket,resolve);});chmodSync(c.socket,0o600);
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 timer=setInterval(()=>{if(Date.now()>=c.deadlineMs||performance.now()-start>=duration)void cleanup();},25);
 onReady();if(duration===0)void cleanup();
 return {finished,cleanup};
}
export function provider(key,fetcher=fetch){
 if(typeof key!=='string'||!key||/[\r\n\x00]/.test(key)||key.length>4096)throw Error('Credential unavailable');
 async function request(method,id){
  const r=await fetcher('https://api.runpod.io/v2/serverless/'+id,{method,redirect:'error',headers:{authorization:'Bearer '+key},signal:AbortSignal.timeout(2000)});
  if(r.status===404){await r.body?.cancel();return null;}
  if(method==='DELETE'&&r.status===204){await r.body?.cancel();return true;}
  if(method!=='GET'||!r.ok){await r.body?.cancel();throw Error('Cleanup operation unconfirmed');}
  const reader=r.body?.getReader();if(!reader)throw Error('Missing response');let chunks=[],size=0;
  for(;;){const b=await reader.read();if(b.done)break;size+=b.value.length;if(size>100000){await reader.cancel();throw Error('Oversized response');}chunks.push(b.value);}
  const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(v.id!==id||typeof v.createdAt!=='string')throw Error('Provider binding differs');return {id:v.id,createdAt:v.createdAt};
 }
 return {inspect:id=>request('GET',id),remove:id=>request('DELETE',id)};
}
