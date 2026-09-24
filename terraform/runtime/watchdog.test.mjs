import test from 'node:test';
import assert from 'node:assert/strict';
import { sweep } from './watchdog.mjs';
const id='disposabletest1';
const past={ [id]: {delete_after:'2026-01-01T00:00:00Z'} };
function fixture(statuses){const calls=[],records=[];return {calls,records,options:{endpoints:past,now:Date.parse('2026-01-02T00:00:00Z'),getKey:async()=>'dummy-test-only',request:async(i,m)=>{calls.push([i,m]);return statuses.shift();},record:async r=>records.push(r)}};}
test('nothing due reads no credentials and performs no provider work',async()=>{const f=fixture([]);f.options.now=0;f.options.getKey=async()=>assert.fail('credential read');assert.deepEqual(await sweep(f.options),{due:0,absent:0});assert.equal(f.calls.length,0);});
test('expired registered endpoint: intent then DELETE then independent absence',async()=>{const f=fixture([200,204,404]);assert.deepEqual(await sweep(f.options),{due:1,absent:1});assert.deepEqual(f.calls.map(x=>x[1]),['GET','DELETE','GET']);assert.equal(f.records[0].status,'cleanup_intent');assert.equal(f.records[1].deleteAcknowledged,true);assert.equal(f.records[1].rangeCredit,false);assert.equal(f.records[1].jobDrainVerified,false);});
test('already absent does not fabricate delete acknowledgement',async()=>{const f=fixture([404]);await sweep(f.options);assert.equal(f.calls.length,1);assert.equal(f.records[1].deleteAcknowledged,false);});
test('authorization/provider failures do not delete or mark absent',async()=>{for(const s of [401,402,403,500]){const f=fixture([s]);await assert.rejects(sweep(f.options));assert.equal(f.calls.length,1);assert.equal(f.records.at(-1).status,'cleanup_unresolved');}});
test('delete success without independently confirmed absence is unresolved',async()=>{const f=fixture([200,204,200]);await assert.rejects(sweep(f.options));assert.equal(f.records.at(-1).status,'cleanup_unresolved');});
test('failed delete is not silently retried in the invocation',async()=>{const f=fixture([200,500]);await assert.rejects(sweep(f.options));assert.equal(f.calls.length,2);});
test('invalid target/deadline fails before credentials',async()=>{for(const endpoints of [{'https://elsewhere':{delete_after:'2026-01-01T00:00:00Z'}},{[id]:{delete_after:'invalid'}}]){const f=fixture([]);f.options.endpoints=endpoints;f.options.getKey=async()=>assert.fail('credential read');await assert.rejects(sweep(f.options));assert.equal(f.calls.length,0);}});
test('intent persistence failure prohibits provider mutation',async()=>{const f=fixture([]);f.options.record=async()=>{throw Error('db unavailable');};await assert.rejects(sweep(f.options));assert.equal(f.calls.length,0);});
