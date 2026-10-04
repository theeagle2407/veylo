import test from 'node:test';import assert from 'node:assert/strict';import {Wallet} from '../wallet.mjs';
test('read checks reuse a recent snapshot, isolate returned objects and refresh at expiry',async()=>{
 let now=0,scans=0;const w=new Wallet({}, {clock:()=>now});w.readSnapshot=async()=>({height:++scans,transactions:[]});
 const a=await w.snapshot();a.transactions.push('tampered');assert.deepEqual(await w.snapshot(),{height:1,transactions:[]});assert.equal(scans,1);
 now=10000;assert.equal((await w.snapshot()).height,2);await w.snapshot({fresh:true});assert.equal(scans,3);
});
test('concurrent reads share one scan and a failed fresh scan cannot serve stale evidence',async()=>{
 const w=new Wallet({});let release,scans=0;w.readSnapshot=()=>{scans++;return new Promise(r=>release=r);};
 const a=w.snapshot(),b=w.snapshot();release({height:12,transactions:[]});assert.deepEqual(await a,await b);assert.equal(scans,1);
 w.readSnapshot=async()=>{throw Error('offline');};await assert.rejects(w.snapshot({fresh:true}),/offline/);await assert.rejects(w.snapshot(),/offline/);
});
test('successful and uncertain sends invalidate cached evidence',async()=>{
 for(const fails of [false,true]){const w=new Wallet({});let scans=0;w.readSnapshot=async()=>({height:++scans,transactions:[]});await w.snapshot();
 w.run=async()=>{if(fails)throw Error('timeout');return {stdout:'a'.repeat(64)};};
 if(fails)await assert.rejects(w.send('address',1,'memo'),/timeout/);else await w.send('address',1,'memo');
 await w.snapshot();assert.equal(scans,2);}
});
test('invalidating an in-flight snapshot prevents caching its result',async()=>{
 const w=new Wallet({});let release,scans=0;w.readSnapshot=()=>{scans++;return new Promise(r=>release=r);};
 const a=w.snapshot();w.invalidateSnapshot();release({height:1,transactions:[]});await a;
 const b=w.snapshot();release({height:2,transactions:[]});assert.equal((await b).height,2);assert.equal(scans,2);
});
