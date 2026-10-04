import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {Store} from '../core.mjs';
import {Payments} from '../payments.mjs';
import {products} from '../catalog.mjs';
const key=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'});
test('orders and receipts retain the selected product and price across restart',()=>{
 const store=new Store();
 for(const p of products){const o=store.createPurchase(key(),p.id);assert.equal(o.product.id,p.id);const restored=new Store(JSON.parse(JSON.stringify(store.state)));const r=restored.simulatePayment(o.id);assert.equal(r.product,p.id);assert.equal(r.amount,p.price);assert(restored.validateReceipt(r));}
 assert.throws(()=>store.createPurchase(key(),'missing'),/not found/);
});
test('release notices are scoped to the selected product',()=>{
 const s=new Store();s.publishNotice({productId:'scopekit',title:'Update',body:'Corrected checklist.'});assert.equal(s.state.notices[0].product,'scopekit');
 assert.throws(()=>s.publishNotice({productId:'missing',title:'Update',body:'Hello'}),/not found/);
});
test('testnet invoice and refund use original product amount, not Fieldnotes amount',async()=>{
 const store=new Store();let sent;
 const wallet={config:{account:'seller'},exclusive:f=>f(),run:async()=>({stdout:' Address: utest1'+'a'.repeat(90)+'\n',stderr:' - Network: testnet\n'}),snapshot:async()=>({height:100,transactions:[]}),send:async(a,v,m)=>{sent=v;return 'a'.repeat(64);}};
 const payments=new Payments(store,wallet);const i=await payments.create(key(),'scopekit');assert.equal(i.value,300000);assert.equal(i.product.name,'Scopekit');
 const p=store.state.purchases[i.id];p.receipt={paymentMode:'testnet'};
 store.state.requests.r={id:'r',purchaseId:i.id,status:'requested',destination:'utest1'+'b'.repeat(90)};
 await payments.refund('r');assert.equal(sent,300000);assert.equal(store.state.requests.r.status,'broadcast');
 await assert.rejects(payments.refund('r'),/already attempted/);
});
