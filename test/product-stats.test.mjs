import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,sign} from 'node:crypto';import {Store,receiptPayload} from '../core.mjs';import {productStats} from '../product-stats.mjs';
const key=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'});
test('product totals exclude unpaid orders, other products and other modes; refunds remain completed purchases',()=>{
 const s=new Store();const a=s.createPurchase(key(),'contour'),b=s.createPurchase(key(),'contour');s.createPurchase(key(),'contour');s.simulatePayment(a.id);s.simulatePayment(b.id);s.simulatePayment(s.createPurchase(key(),'chime').id);
 s.state.requests.r={purchaseId:a.id,status:'simulated'};s.state.reviews={[a.id]:{id:'public-id',product:'contour',paymentMode:'simulation',rating:4,text:'Useful.',updatedAt:'2026-10-04T00:00:00Z'}};
 const stats=productStats(s,'contour','simulation');assert.equal(stats.purchases,2);assert.equal(stats.refunded,1);assert.equal(stats.averageRating,4);assert(!JSON.stringify(stats).includes(a.id));assert.equal(productStats(s,'contour','testnet').purchases,0);
 s.state.purchases[b.id].receipt.amount='99';assert.equal(productStats(s,'contour','simulation').purchases,1);
});
test('testnet count uses signed receipts and does not invent a unique-buyer count',()=>{
 const s=new Store(),p=s.createPurchase(key(),'contour'),r=s.simulatePayment(p.id);r.paymentMode='testnet';r.payment={network:'testnet',txid:'a'.repeat(64)};r.signature=sign(null,Buffer.from(receiptPayload(r)),s.state.secret).toString('base64url');
 const stats=productStats(s,'contour','testnet');assert.equal(stats.purchases,1);assert.equal(stats.averageRating,null);assert.equal(stats.reviewCount,0);assert(!('buyers' in stats));
});
