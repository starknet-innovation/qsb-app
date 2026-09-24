import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {lstatSync} from 'node:fs';
/** Probe a private, owned Unix socket; never infer liveness from a saved PID. */
export function probeWatchdog(socket:string,endpoint:string,deadlineMs:number):Promise<{endpoint:string;live:true;deadlineMs:number;handle:string}>{
 const stat=lstatSync(socket);if(!stat.isSocket()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error('Untrusted watchdog socket');
 const nonce=randomBytes(16).toString('hex');
 return new Promise((resolve,reject)=>{const c=net.connect(socket);let text='',settled=false;
  const fail=()=>{if(!settled){settled=true;reject(Error('Watchdog not live'));}c.destroy();};
  c.setTimeout(1000,fail);c.on('error',fail);c.on('connect',()=>c.write(JSON.stringify({nonce})+'\n'));
  c.on('data',b=>{text+=b;if(text.length>2048)fail();});
  c.on('end',()=>{if(settled)return;try{const r=JSON.parse(text);if(r.nonce!==nonce||r.endpoint!==endpoint||r.deadlineMs!==deadlineMs||r.live!==true||!Number.isSafeInteger(r.pid)||r.pid<=0)throw Error();settled=true;resolve({endpoint,live:true,deadlineMs,handle:socket});}catch{fail();}});
 });
}
