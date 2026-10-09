import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {Store} from '../core.mjs';
import {SellerAccounts} from '../seller-accounts.mjs';
import {MerchantCatalog} from '../merchant.mjs';
import {ConnectorJobs,RemoteWallet} from '../connector-jobs.mjs';
import {ConnectorRunner} from '../connector-runner.mjs';
import {Payments} from '../payments.mjs';
const account='6be4ea81-7f3a-44ee-9801-312ec18976e3';
const address='utest1'+'a'.repeat(90);
async function fixture(t){
 const store=new Store(),accounts=new SellerAccounts(store);const actor=accounts.actor(await accounts.register({username:'alice',name:'Alice shop',password:'sufficiently long password'}));
 const token=accounts.pair(actor).token;accounts.heartbeat(token,{network:'test',height:100,account,protocol:2});
 const bob=accounts.actor(await accounts.register({username:'bobby',name:'Bob shop',password:'sufficiently long password'}));const other=accounts.pair(bob).token;accounts.heartbeat(other,{network:'test',height:100,account,protocol:2});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'veylo-multi-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const catalog=new MerchantCatalog(store,{root:process.cwd(),assetDir:dir});store.productLookup=(id,archive=false)=>catalog.get(id,archive);
 const input={name:'Seller pack',description:'A complete seller product for testing.',category:'Other',version:'1',price:'0.001',fileName:'pack.txt',fileBase64:Buffer.from('product').toString('base64')};
 const product=catalog.publish(actor,input);
 return {store,accounts,actor,token,bob,other,dir,catalog,product};
}
test('published products retain seller ownership and cannot be changed by another store',async t=>{
 const f=await fixture(t);assert.equal(f.catalog.get(f.product.id).seller,'Alice shop');assert.equal(f.catalog.dashboard(f.bob).products.length,0);assert.throws(()=>f.catalog.setStatus(f.bob,f.product.id,'archived'));
 f.accounts.profile(f.actor,{name:'Alice renamed',bio:'My products'});assert.equal(f.catalog.get(f.product.id).seller,'Alice renamed');assert.equal(f.catalog.profileFor('primary').name,'Veylo Studio');
 assert.throws(()=>f.accounts.heartbeat(f.token,{network:'test',height:100,account:'ab'.repeat(18),protocol:2}),/different wallet/);
});
test('remote payment and refund lifecycle uses owned wallet evidence, ten confirmations and one local send',async t=>{
 const f=await fixture(t),jobs=new ConnectorJobs(f.store,f.accounts,{timeout:2000});let snapshot={height:100,transactions:[]},sends=0;
 const wallet={config:{account,identity:'local-only'},run:async()=>({stdout:`Address: ${address}`,stderr:'Network: testnet'}),snapshot:async()=>structuredClone(snapshot),send:async()=>{sends++;return 'b'.repeat(64);}};
 const request=async(route,b)=>route.endsWith('/claim')?jobs.claim(f.token,b.id):jobs.complete(f.token,b.id,b.result);
 const runner=new ConnectorRunner({wallet,journalPath:path.join(f.dir,'journal.json'),approve:async()=>true,request});
 const payments=new Payments(f.store,new RemoteWallet(f.actor,jobs),f.actor);
 async function process(operation){let done=false;const pending=operation.finally(()=>done=true);while(!done){for(const job of jobs.poll(f.token))await runner.run(job);await new Promise(r=>setTimeout(r,2));}return pending;}
 const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'});
 const invoice=await process(payments.create(key,f.product.id));assert.equal(invoice.value,100000);
 snapshot={height:109,transactions:[{txid:'a'.repeat(64),minedHeight:101,outputs:[{index:0,pool:'Ironwood',change:false,receivedBy:account,memo:invoice.memo,value:100000}]}]};
 payments.wallet.invalidateSnapshot();let result=await process(payments.check(invoice.id,invoice.token));assert.equal(result.status,'confirming');
 payments.wallet.invalidateSnapshot();snapshot.height=110;
 result=await process(payments.check(invoice.id,invoice.token));assert.equal(result.status,'confirmed');assert.equal(result.receipt.payment.confirmationsAtIssue,10);
 const id='12345678-1234-1234-1234-123456789abc';f.store.state.requests[id]={id,purchaseId:invoice.id,status:'requested',destination:address,amount:'0.001'};
 const otherPayments=new Payments(f.store,new RemoteWallet(f.bob,jobs),f.bob);
 await assert.rejects(otherPayments.refund(id),/Wrong seller/);
 await process(payments.refund(id));assert.equal(sends,1);assert.equal(f.store.state.requests[id].status,'broadcast');
 await assert.rejects(payments.refund(id),/already attempted/);
 snapshot.height=120;snapshot.transactions.push({txid:'b'.repeat(64),minedHeight:111,outputs:[{index:1,pool:'Ironwood',change:false,sentFrom:account,memo:'veylo:refund:'+id,value:100000,address}]});
 await process(payments.refresh());assert.equal(f.store.state.requests[id].status,'confirmed');assert.equal(f.store.downloadAllowed(invoice.id),false);
 const sent=Object.values(f.store.state.connectorJobs).find(j=>j.kind==='send');await runner.run(sent);assert.equal(sends,1);
 assert.throws(()=>jobs.complete(f.other,sent.id,{value:'c'.repeat(64)}),/not found/);
});
test('a lost send response and connector restart cannot send twice',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'veylo-retry-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let sends=0,completes=0;
 const journalPath=path.join(dir,'ops.json');const wallet={config:{account,identity:'local'},snapshot:async()=>({}),send:async()=>{sends++;return 'a'.repeat(64);}};
 const job={id:'job',account,kind:'send',input:{address,value:100000,memo:'veylo:refund:12345678-1234-1234-1234-123456789abc'}};
 const request=async route=>{if(route.endsWith('/claim'))return {claimed:true};completes++;if(completes===1)throw Error('Lost response');return {ok:true};};
 const make=()=>new ConnectorRunner({wallet,journalPath,request,approve:async()=>true});
 await assert.rejects(make().run(job),/Lost response/);await make().run(job);assert.equal(sends,1);
});
test('interrupted journal blocks sends and a refused local confirmation sends nothing',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'veylo-decline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let sends=0;
 const journalPath=path.join(dir,'ops.json');const job={id:'job',account,kind:'send',input:{address,value:1,memo:'veylo:refund:12345678-1234-1234-1234-123456789abc'}};
 const wallet={config:{account,identity:'local'},send:async()=>sends++};const request=async()=>({claimed:true});
 const runner=new ConnectorRunner({wallet,journalPath,request,approve:async()=>false});await runner.run(job);assert.equal(sends,0);
 fs.writeFileSync(journalPath,JSON.stringify({job:{startedAt:1}}));const restarted=new ConnectorRunner({wallet,journalPath,request,approve:async()=>true});await restarted.run(job);assert.equal(sends,0);
});
