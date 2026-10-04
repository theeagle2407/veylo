import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store} from '../core.mjs';
import {MerchantCatalog,OWNER} from '../merchant.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const key=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'});
const input=()=>({name:'Studio Checklist',description:'A practical checklist for preparing a studio release.',category:'Templates',version:'1.0',price:'0.00123456',fileName:'studio-checklist.txt',fileBase64:Buffer.from('Prepare, check, publish.').toString('base64')});
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'veylo-merchant-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=new Store(),m=new MerchantCatalog(s,{root,assetDir:dir});s.productLookup=(id,archived)=>m.get(id,archived);return {s,m,dir};}
test('merchant authentication, upload validation, and exact decimal prices',t=>{
 const {m}=setup(t);assert.throws(()=>m.publish('other',input()),/authorization/);assert.throws(()=>m.profile('other',{name:'Other',bio:'Other'}),/authorization/);
 for(const patch of [{price:'1e-3'},{price:'0'},{price:'0.000000001'},{fileName:'../private.txt'},{fileBase64:'bad!'},{fileBase64:''}])assert.throws(()=>m.publish(OWNER,{...input(),...patch}));
 const p=m.publish(OWNER,input());assert.equal(p.value,123456);assert.equal(p.price,'0.00123456');assert.equal(p.sellerId,OWNER);assert(m.list().some(x=>x.id===p.id));
 assert(!('delivery' in p));assert.equal(m.readDelivery(m.get(p.id).delivery).bytes.toString(),'Prepare, check, publish.');
});
test('archived products reject new orders while pending purchases and signed delivery survive restart',t=>{
 const {s,m,dir}=setup(t),p=m.publish(OWNER,input()),o=s.createPurchase(key(),p.id);
 m.setStatus(OWNER,p.id,'archived');assert.throws(()=>s.createPurchase(key(),p.id),/not available/);assert(!m.list().some(x=>x.id===p.id));
 const r=s.simulatePayment(o.id);assert(s.validateReceipt(r));assert.equal(r.delivery.sha256,m.get(p.id,true).delivery.sha256);assert(!s.validateReceipt({...r,delivery:{...r.delivery,sha256:'a'.repeat(64)}}));
 const restored=new Store(JSON.parse(JSON.stringify(s.state))),again=new MerchantCatalog(restored,{root,assetDir:dir});assert(restored.validateReceipt(r));assert.equal(again.readDelivery(r.delivery).bytes.toString(),'Prepare, check, publish.');
 m.setStatus(OWNER,p.id,'published');assert(s.createPurchase(key(),p.id));
});
test('immutable assets reject disk corruption and metadata save failures roll back',t=>{
 const {s,m,dir}=setup(t),p=m.publish(OWNER,input()),d=m.get(p.id).delivery;
 fs.writeFileSync(path.join(dir,d.sha256),'tampered');assert.throws(()=>m.readDelivery(d),/integrity/);
 const before=JSON.stringify(m.data());s.save=()=>{throw Error('Disk full');};assert.throws(()=>m.profile(OWNER,{name:'Changed',bio:'Changed profile'}),/Disk full/);assert.equal(JSON.stringify(m.data()),before);
});
test('existing receipts are not rewritten by catalogue migration',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'veylo-legacy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=new Store(),o=s.createPurchase(key()),r=s.simulatePayment(o.id),before=JSON.stringify(r);new MerchantCatalog(s,{root,assetDir:dir});assert.equal(JSON.stringify(s.state.purchases[o.id].receipt),before);assert(s.validateReceipt(r));assert(!r.delivery);
});
