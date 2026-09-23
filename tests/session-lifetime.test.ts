import assert from 'node:assert/strict';
import {createSessionClient} from '../src/lib/session';
import {test} from 'vitest';
const token='T'.repeat(43), other='U'.repeat(43);
function deferred<T>() { let resolve!:(x:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}; }
const response=(x:unknown)=>new Response(JSON.stringify(x));
async function main(){
 let passed=0;
 for(const stage of ['challenge','signature','verify']){
  const gate=deferred<void>(), entered=deferred<void>();let signs=0,verifies=0;
  const client=createSessionClient(async(input)=>{
   if(String(input).endsWith('challenge')){if(stage==='challenge'){entered.resolve();await gate.promise;}return response({id:'challenge',message:'test'});}
   verifies++;if(stage==='verify'){entered.resolve();await gate.promise;}return response({token});
  });
  const pending=client.authenticate('wallet',async()=>{signs++;if(stage==='signature'){entered.resolve();await gate.promise;}return 'synthetic';});
  const rejected=assert.rejects(pending,/session changed/);await entered.promise;client.clearSession();gate.resolve();await rejected;
  assert.equal(client.currentToken(),undefined);assert.equal(signs,stage==='challenge'?0:1);assert.equal(verifies,stage==='verify'?1:0);passed++;
 }
 {
  const gate=deferred<void>(),entered=deferred<void>();let calls=0;
  const c=createSessionClient(async(input)=>String(input).endsWith('challenge')?response({id:'x',message:'x'}):response({token:++calls===1?other:token}));
  const first=c.authenticate('old',async()=>{entered.resolve();await gate.promise;return 'old';});const rejected=assert.rejects(first,/session changed/);
  await entered.promise;await c.authenticate('new',async()=> 'new');gate.resolve();await rejected;assert.equal(c.currentToken(),other);assert.equal(calls,1);passed++;
 }
 {
  const c=createSessionClient(async(input)=>String(input).endsWith('challenge')?response({id:'x',message:'x'}):response({token:'invalid'}));
  await assert.rejects(c.authenticate('wallet',async()=> 'signature'),/Invalid authentication/);assert.equal(c.currentToken(),undefined);passed++;
 }
 {
  let authorization:string|null=null;const c=createSessionClient(async(input,init)=>{
   if(String(input).endsWith('challenge'))return response({id:'x',message:'x'});
   if(String(input).endsWith('verify'))return response({token});
   authorization=new Headers(init?.headers).get('Authorization');return response({ok:true});
  });await c.authenticate('wallet',async()=> 'signature');assert.deepEqual(await c.api('/read'),{ok:true});assert.equal(authorization,'Bearer '+token);c.clearSession();await c.api('/read');assert.equal(authorization,null);passed++;
 }
 {
 const c=createSessionClient(async(input)=>String(input).endsWith('challenge')?response({id:'x',message:'x'}):response({token:[token]}));
 await assert.rejects(c.authenticate('wallet',async()=> 'signature'),/Invalid authentication/);assert.equal(c.currentToken(),undefined);passed++;
 }
 console.log(JSON.stringify({passed,network:'mocked fetch',wallet:'mocked signer',productionMounted:false}));
}
test('session invalidation covers asynchronous authentication boundaries', main);
