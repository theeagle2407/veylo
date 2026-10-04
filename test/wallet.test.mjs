import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {parseTransactions,findOutputs} from '../wallet.mjs';
import {Payments} from '../payments.mjs';
import {Store} from '../core.mjs';
const account='6be4ea81-7f3a-44ee-9801-312ec18976e3';
const txid='b7579bc5dd95c6f497bbbc167a223ce431b7bebf3d746eca233b70e49437e7eb';
const address='utest1'+'a'.repeat(90);
function listing(memo='veylo:pay:abc'){return `Transactions:
${txid}
 Mined: 4442932 (2026-10-03 4:46:06.0 +00:00:00)
 Amount:   0.00100000 TAZ
 Fee paid:   0.00025000 TAZ
 Sent 0 notes, received 1 notes, 1 memos
 Output 0 (Ironwood)
 Value:   0.00100000 TAZ
 Received by account: ${account} (Veylo Seller)
 To: ${address}
 Memo: Memo::Text("${memo}")
`;}
const key=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'});
function harness(){
 const store=new Store();let snapshot={height:4442930,transactions:[]},sends=0,crash=false;
 const wallet={config:{account},exclusive:f=>f(),run:async()=>({stdout:`Account AccountUuid(${account})\n Address: ${address}\n - Network: testnet\n`}),snapshot:async()=>snapshot,send:async()=>{sends++;if(crash)throw Error('timeout after broadcast');return 'a'.repeat(64);}};
 const payments=new Payments(store,wallet);
 return {store,wallet,payments,setSnapshot:s=>snapshot=s,setCrash:()=>crash=true,sends:()=>sends};
}
function snap(invoice,conf=10){return {height:4442932+conf-1,transactions:parseTransactions(listing(invoice.memo))};}
test('parse enriched recipient output without charging transaction fee to recipient',()=>{
 const t=parseTransactions(listing());assert.equal(t[0].outputs[0].value,100000);assert.equal(t[0].outputs[0].memo,'veylo:pay:abc');assert.equal(t[0].minedHeight,4442932);
});
test('reject changed output format and repeated output indexes',()=>{
 assert.throws(()=>parseTransactions(listing()+'Unexpected field\n'));
 assert.throws(()=>parseTransactions(listing()+'Output 0 (Ironwood)\nValue: 0.00100000 TAZ\n'));
});
test('escaped memo cannot inject wallet fields or match an order',()=>{
 const t=parseTransactions(listing('veylo:pay:abc\\nOutput 0 (Ironwood)'));assert.equal(t[0].outputs[0].memo,null);
});
test('matching checks account, amount, direction, shielded pool, change and reference',()=>{
 const snapshot={height:4443000,transactions:parseTransactions(listing())};
 const filter={account,memo:'veylo:pay:abc',value:100000,direction:'receivedBy'};
 assert.equal(findOutputs(snapshot,filter).length,1);
 for(const change of [{account:'other'},{value:1},{memo:'wrong'},{direction:'sentFrom'},{afterHeight:4444000}])assert.equal(findOutputs(snapshot,{...filter,...change}).length,0);
 snapshot.transactions[0].outputs[0].change=true;assert.equal(findOutputs(snapshot,filter).length,0);
 snapshot.transactions[0].outputs[0].change=false;snapshot.transactions[0].outputs[0].pool='Transparent';assert.equal(findOutputs(snapshot,filter).length,0);
});
test('payment receipt waits for ten confirmations and binds blockchain proof',async()=>{
 const h=harness(),i=await h.payments.create(key());
 h.setSnapshot(snap(i,9));assert.equal((await h.payments.check(i.id,i.token)).status,'confirming');assert.equal(h.store.state.purchases[i.id].receipt,undefined);
 h.setSnapshot(snap(i));const r=await h.payments.check(i.id,i.token);assert.equal(r.status,'confirmed');assert(h.store.validateReceipt(r.receipt));
 assert(!h.store.validateReceipt({...r.receipt,payment:{...r.receipt.payment,txid:'0'.repeat(64)}}));
 assert.equal((await h.payments.check(i.id,i.token)).receipt.signature,r.receipt.signature);
 await assert.rejects(h.payments.check(i.id,'invalid'));assert.throws(()=>h.store.simulatePayment(i.id));
});
test('an output cannot issue two receipts; duplicate matching transfers require review',async()=>{
 const h=harness(),i=await h.payments.create(key());h.setSnapshot(snap(i));h.store.state.usedPayments[`testnet:${txid}:Ironwood:0`]='different-order';await assert.rejects(h.payments.check(i.id,i.token),/already used/);
 h.store.state.usedPayments={};const s=snap(i);s.transactions.push({...s.transactions[0],txid:'b'.repeat(64)});h.setSnapshot(s);await assert.rejects(h.payments.check(i.id,i.token),/Multiple/);
});
test('refund timeout persists unknown; repeating cannot send again, including after restart',async()=>{
 const h=harness(),i=await h.payments.create(key());h.setSnapshot(snap(i));await h.payments.check(i.id,i.token);
 h.store.state.requests.r={id:'r',purchaseId:i.id,amount:'0.001',destination:address,status:'requested'};h.setCrash();
 await assert.rejects(h.payments.refund('r'),/outcome needs checking/);assert.equal(h.sends(),1);assert.equal(h.store.state.requests.r.status,'unknown');
 const restored=new Payments(new Store(JSON.parse(JSON.stringify(h.store.state))),h.wallet);
 await assert.rejects(restored.refund('r'),/already attempted/);assert.equal(h.sends(),1);
});
test('refund reconciliation requires exact destination, memo, amount and confirmed outgoing output',async()=>{
 const h=harness(),q={id:'r',memo:'veylo:refund:r',value:100000,destination:address,status:'unknown'};
 let s={height:4442941,transactions:parseTransactions(listing(q.memo).replace('Received by account:','Sent from account:'))};
 await h.payments.reconcile(q,{...s,transactions:[{...s.transactions[0],outputs:s.transactions[0].outputs.map(o=>({...o,address:'utest1wrong'}))}]});assert.equal(q.status,'unknown');
 await h.payments.reconcile(q,s);assert.equal(q.status,'confirmed');assert.equal(q.txid,txid);
});
