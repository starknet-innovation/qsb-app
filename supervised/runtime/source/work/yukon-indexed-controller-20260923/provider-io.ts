/** Queue data plane only. No provisioning, paid retries, logs or secret lookup. */
const FORBIDDEN=new Set(['historical-proof-disabled-a','historical-proof-disabled-b']);
const RETRY=new Set([429,500,502,503,504]);
export class ProviderIO {
 #key:string;
 #base:string;
 constructor(readonly endpoint:string,runUrl:string,key:string,private fetcher:typeof fetch=fetch,private deadlineMs=20000){
  if(!/^[a-z0-9]+$/.test(endpoint)||FORBIDDEN.has(endpoint))throw Error('Invalid or spent endpoint');
  const url=new URL(runUrl);
  if(url.origin!=='https://api.runpod.ai'||url.pathname!==`/v2/${endpoint}/run`||url.search||url.hash||url.username||url.password)throw Error('Unexpected provider URL');
  if(!key||/[\r\n]/.test(key)||!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>20000)throw Error('Invalid transport configuration');
  this.#key=key;this.#base=url.origin+`/v2/${endpoint}`;
 }
 private async request(operation:string,id:string|undefined,input:unknown,read:boolean){
  if(id!==undefined&&!/^[a-zA-Z0-9_-]{1,512}$/.test(id))throw Error('Invalid provider ID');
  const body=read?undefined:JSON.stringify(input);
  if(body!==undefined&&Buffer.byteLength(body)>200000)throw Error('Oversized request');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.deadlineMs);
  try{
   for(let attempt=0;attempt<(read?3:1);attempt++){
    const response=await this.fetcher(this.#base+'/'+operation+(id?'/'+id:''),{method:read?'GET':'POST',redirect:'error',signal:controller.signal,headers:{authorization:'Bearer '+this.#key,'content-type':'application/json'},body});
    if(!response.ok){
     await response.body?.cancel();
     if(read&&RETRY.has(response.status)&&attempt<2){
      await new Promise<void>((resolve,reject)=>{if(controller.signal.aborted){reject(Error('deadline'));return;}const abort=()=>{clearTimeout(t);reject(Error('deadline'));};const t=setTimeout(()=>{controller.signal.removeEventListener('abort',abort);resolve();},attempt===0?250:750);controller.signal.addEventListener('abort',abort,{once:true});});continue;
     }
     throw Error('http');
    }
    const reader=response.body?.getReader();if(!reader)throw Error('empty');let size=0;const chunks:Uint8Array[]=[];
    for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>2000000){await reader.cancel();throw Error('oversize');}chunks.push(chunk.value);}
    if(controller.signal.aborted)throw Error('deadline');
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||!/^[a-zA-Z0-9_-]{1,512}$/.test(value.id)||(id!==undefined&&value.id!==id))throw Error('identity');
    if(read&&!['IN_QUEUE','IN_PROGRESS','COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(value.status))throw Error('status');
    return value;
   }
   throw Error('attempts');
  }catch{throw Error(read?'Provider observation unavailable; preserve durable state':'Provider submission/cancellation outcome uncertain; reconcile without retry');}
  finally{clearTimeout(timer);}
 }
 async send(endpoint:string,event:unknown){if(endpoint!==this.endpoint)throw Error('Endpoint mismatch');return this.request('run',undefined,{input:event},false);}
 async read(endpoint:string,id:string){if(endpoint!==this.endpoint)throw Error('Endpoint mismatch');return this.request('status',id,undefined,true);}
 async cancel(endpoint:string,id:string){if(endpoint!==this.endpoint)throw Error('Endpoint mismatch');return this.request('cancel',id,{},false);}
}
