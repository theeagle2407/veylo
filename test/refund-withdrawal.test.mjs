import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Store,requestPayload} from '../core.mjs';
import {Payments} from '../payments.mjs';
function setup(){
 let now=1000;const store=new Store(undefined,()=>{},()=>now),keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const p=store.createPurchase(keys.publicKey.export({format:'jwk'}));store.simulatePayment(p.id);
 const signed=payload=>sign('sha256',Buffer.from(payload),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 const request=()=>{const r={purchaseId:p.id,nonce:store.issueChallenge(p.id).nonce,destination:'utest1'+'a'.repeat(90),reason:'Wrong edition'};return store.requestRefund(r,signed(requestPayload(r)));};
 const withdraw=q=>{const r={purchaseId:p.id,nonce:store.issueChallenge(p.id).nonce,requestId:q.id};return {r,sig:signed(JSON.stringify(['veylo.refund.withdraw.v1',r.purchaseId,r.nonce,r.requestId]))};};
 return {store,p,request,withdraw,signed,expire:()=>now+=120001};
}
test('withdrawal preserves history, permits one corrected request, and status selects the new request',()=>{
 const x=setup(),q=x.request(),{r,sig}=x.withdraw(q);x.store.withdrawRefund(r,sig);assert.equal(q.status,'withdrawn');
 assert.throws(()=>x.store.withdrawRefund(r,sig),/expired|used/);assert.throws(()=>x.store.simulateRefund(q.id),/processed/);
 const next=x.request();assert.notEqual(next.id,q.id);assert.throws(x.request,/already exists/);
 const query={purchaseId:x.p.id,nonce:x.store.issueChallenge(x.p.id).nonce};
 const status=x.store.purchaseStatus(query,x.signed(JSON.stringify(['veylo.status.v1',query.purchaseId,query.nonce])));
 assert.equal(status.refund.id,next.id);assert.equal(status.refund.status,'requested');
 const restored=new Store(JSON.parse(JSON.stringify(x.store.state)));assert.equal(restored.state.requests[q.id].status,'withdrawn');assert.equal(restored.downloadAllowed(x.p.id),true);
});
test('withdrawal rejects forged signatures, changed request IDs, expired challenges and processing states',()=>{
 const x=setup(),q=x.request(),{r,sig}=x.withdraw(q);
 assert.throws(()=>x.store.withdrawRefund({...r,requestId:'other'},sig),/signature/);
 assert.throws(()=>x.store.withdrawRefund(r,'bad'),/signature/);
 x.expire();assert.throws(()=>x.store.withdrawRefund(r,sig),/expired/);
 for(const status of ['sending','unknown','broadcast','confirmed','needs_review','simulated','withdrawn']){
  const y=setup(),v=y.request();v.status=status;const a=y.withdraw(v);assert.throws(()=>y.store.withdrawRefund(a.r,a.sig),/no longer/);
 }
});
test('withdrawal during approval wallet sync prevents sending; processing blocks withdrawal',async()=>{
 const x=setup(),q=x.request();x.p;const p=x.store.state.purchases[x.p.id];p.receipt.paymentMode='testnet';p.payment={value:100000};
 let release,started;const ready=new Promise(r=>started=r);let sends=0;
 const wallet={exclusive:f=>f(),snapshot:()=>{started();return new Promise(r=>release=r);},send:async()=>{sends++;return 'a'.repeat(64);}};
 const payments=new Payments(x.store,wallet),pending=payments.refund(q.id);await ready;
 const a=x.withdraw(q);x.store.withdrawRefund(a.r,a.sig);release({});await assert.rejects(pending,/withdrawn/);assert.equal(sends,0);
 const next=x.request();wallet.snapshot=async()=>({});let finish;
 wallet.send=()=>{sends++;return new Promise(r=>finish=r);};const payment=payments.refund(next.id);await new Promise(r=>setImmediate(r));
 assert.equal(next.status,'sending');const b=x.withdraw(next);assert.throws(()=>x.store.withdrawRefund(b.r,b.sig),/no longer/);finish('b'.repeat(64));await payment;assert.equal(sends,1);
});
test('seller decline requires a reason, preserves access, and exposes a private decision in purchase status',()=>{
 const x=setup(),q=x.request();assert.throws(()=>x.store.declineRefund(q.id,''),/Explain/);assert.throws(()=>x.store.declineRefund(q.id,'x'.repeat(1001)),/Explain/);
 x.store.declineRefund(q.id,'The purchased edition matches the listed file.');assert.equal(q.status,'declined');assert.equal(x.store.downloadAllowed(x.p.id),true);assert.throws(()=>x.store.simulateRefund(q.id),/processed/);
 const r={purchaseId:x.p.id,nonce:x.store.issueChallenge(x.p.id).nonce};const result=x.store.purchaseStatus(r,x.signed(JSON.stringify(['veylo.status.v1',r.purchaseId,r.nonce])));
 assert.equal(result.refund.decisionReason,q.decisionReason);assert.ok(result.refund.decidedAt);assert.equal(new Store(JSON.parse(JSON.stringify(x.store.state))).state.requests[q.id].status,'declined');
 assert.throws(x.request,/already exists/);
 for(const status of ['sending','unknown','broadcast','confirmed','withdrawn','simulated','needs_review']){q.status=status;assert.throws(()=>x.store.declineRefund(q.id,'Reason'),/unprocessed/);}
});
test('seller decline during wallet sync prevents a payment already awaiting preparation',async()=>{
 const x=setup(),q=x.request(),p=x.store.state.purchases[x.p.id];p.receipt.paymentMode='testnet';p.payment={value:100000};
 let release,started,sends=0;const ready=new Promise(r=>started=r);
 const wallet={exclusive:f=>f(),snapshot:()=>{started();return new Promise(r=>release=r);},send:async()=>{sends++;}};
 const payment=new Payments(x.store,wallet).refund(q.id);await ready;x.store.declineRefund(q.id,'Product was delivered as described.');release({});await assert.rejects(payment);assert.equal(sends,0);assert.equal(q.status,'declined');
});
