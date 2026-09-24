/** Runpod v2 contract verified from saved official OpenAPI. No provisioning methods. */
const MISSING=Symbol('http404'),DELETED=Symbol('http204');
const FORBIDDEN=new Set(['historical-proof-disabled-a','historical-proof-disabled-b']);
export class ControlPlane {
 #key;#created;
 constructor(key,created,fetcher=fetch){
  if(!key||/[\r\n]/.test(key)||!created||!/^[a-z0-9]+$/.test(created.id)||FORBIDDEN.has(created.id)||!Number.isFinite(Date.parse(created.createdAt)))throw Error('Invalid cleanup ownership binding');
  this.#key=key;this.#created=structuredClone(created);this.fetcher=fetcher;
 }
 async #request(method,path,signal){
  const own=AbortSignal.timeout(10000),combined=signal?AbortSignal.any([own,signal]):own;
  try{
   const r=await this.fetcher('https://api.runpod.io'+path,{method,redirect:'error',headers:{authorization:'Bearer '+this.#key},signal:combined});
   if(r.status===404){await r.body?.cancel();return MISSING;}
   if(method==='DELETE'&&r.status===204){await r.body?.cancel();return DELETED;}
   if(!r.ok)throw Error();
   const reader=r.body?.getReader();if(!reader)throw Error();const chunks=[];let bytes=0;
   for(;;){const x=await reader.read();if(x.done)break;bytes+=x.value.length;if(bytes>2000000){await reader.cancel();throw Error();}chunks.push(x.value);}
   return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{throw Error('Control-plane operation unavailable; no absence inferred');}
 }
 async inspect(id,signal){
  if(id!==this.#created.id)throw Error('Unowned endpoint');
  const e=await this.#request('GET','/v2/serverless/'+id,signal);if(e===MISSING)return null;
  if(e.id!==id||e.createdAt!==this.#created.createdAt)throw Error('Endpoint creation identity changed');
  // Deliberately exclude provider environment/registry credentials from returned data.
  const {name,type,image,gpu,workers,requestUrls,createdAt}=e;
  return {id,name,type,image,gpu,workers,requestUrls,createdAt};
 }
 async inventory(signal){
  const collect=async(path,key)=>{let cursor=null;const seen=new Set(),rows=[];
   for(let page=0;page<100;page++){
    const value=await this.#request('GET',path+(cursor?'?cursor='+encodeURIComponent(cursor):''),signal);
    if(!value||!Array.isArray(value[key])||typeof value.pagination?.hasNextPage!=='boolean')throw Error('Incomplete inventory');
    rows.push(...value[key]);const p=value.pagination;
    if(p.hasNextPage===false){if(p.nextCursor!==null)throw Error('Inconsistent pagination');return rows;}
    if(typeof p.nextCursor!=='string'||!p.nextCursor||seen.has(p.nextCursor))throw Error('Repeated/missing inventory cursor');seen.add(p.nextCursor);cursor=p.nextCursor;
   }throw Error('Inventory page limit');
  };
  const [endpoints,pods]=await Promise.all([collect('/v2/serverless','endpoints'),collect('/v2/pods','pods')]);
  return {allEndpoints:endpoints.map(({id,workers,gpu})=>({id,workers,gpu})),pods:pods.map(({id})=>({id})),inventoryComplete:true};
 }
 async remove(id,signal){
  const before=await this.inspect(id,signal);if(!before)return;
  const r=await this.#request('DELETE','/v2/serverless/'+id,signal);if(r!==DELETED&&r!==MISSING)throw Error('Deletion not acknowledged');
 }
}
