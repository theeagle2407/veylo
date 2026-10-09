import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {generateKeyPairSync,sign} from 'node:crypto';
test('HTTP multi-seller publication, payment receipt, refund approval and tenant isolation',async t=>{
 const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'veylo-http-multi-'));
 const child=spawn(process.execPath,['server.mjs'],{env:{...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('VEYLO_'))),PORT:String(port),VEYLO_DATA_DIR:dir,VEYLO_PAYMENT_MODE:'testnet',VEYLO_WALLET_BINARY:'/unused',VEYLO_SELLER_WALLET:'/unused',VEYLO_SELLER_IDENTITY:'/unused',VEYLO_SELLER_ACCOUNT:'unused',VEYLO_SELLER_CODE:'test-code'},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Startup timed out')),5000);child.stdout.on('data',b=>{if(String(b).includes('Veylo:')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('Startup failed'));});});
 const base=`http://127.0.0.1:${port}`;
 async function api(route,body,cookie=''){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Origin:base,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],data:await r.json()};}
 const a=await api('/api/store-account/register',{username:'seller_a',name:'Store A',password:'long password for tests'}),b=await api('/api/store-account/register',{username:'seller_b',name:'Store B',password:'long password for tests'});
 const token=(await api('/api/store-account/pair',{},a.cookie)).data.token;
 const account='6be4ea81-7f3a-44ee-9801-312ec18976e3';
 async function connector(route,body){const r=await fetch(base+'/api/connector/'+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();}
 await connector('heartbeat',{network:'test',height:100,account,protocol:2});
 const product=(await api('/api/seller/products/publish',{name:'New Store Pack',description:'An independently owned downloadable product.',category:'Other',version:'1',price:'0.001',fileName:'pack.txt',fileBase64:Buffer.from('download').toString('base64')},a.cookie));assert.equal(product.status,201);
 assert.equal((await api('/api/seller/products',null,b.cookie)).data.products.length,0);
 assert.equal((await api('/api/seller/products/status',{id:product.data.id,status:'archived'},b.cookie)).status,400);
 let height=100,memo;let sendCount=0;
 const address='utest1'+'a'.repeat(90);
 async function drain(promise){let done=false;const p=promise.finally(()=>done=true);while(!done){for(const j of (await connector('poll',{})).jobs){assert.equal((await connector('claim',{id:j.id})).claimed,true);let value;if(j.kind==='address')value={stdout:'Address: '+address,stderr:'Network: testnet'};if(j.kind==='snapshot')value={height,transactions:memo?[{txid:'a'.repeat(64),minedHeight:101,outputs:[{index:0,pool:'Ironwood',receivedBy:account,change:false,value:100000,memo}]}]:[]};if(j.kind==='send'){sendCount++;value='b'.repeat(64);}await connector('complete',{id:j.id,result:{value}});}await new Promise(r=>setTimeout(r,5));}return p;}
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const order=await drain(api('/api/purchases',{productId:product.data.id,key:keys.publicKey.export({format:'jwk'})}));assert.equal(order.status,201);memo=order.data.memo;height=110;
 // The snapshot cache is ten seconds; advance its clock by waiting only for this integration boundary.
 await new Promise(r=>setTimeout(r,10020));
 const paid=await drain(api('/api/check-payment',{id:order.data.id,token:order.data.token}));assert.equal(paid.data.status,'confirmed');
 assert.equal((await api('/api/seller',null,b.cookie)).data.purchases,0);assert.equal((await api('/api/seller',null,a.cookie)).data.purchases,1);
 const challenge=(await api('/api/challenges',{id:order.data.id})).data;
 const request={purchaseId:order.data.id,nonce:challenge.nonce,destination:address,reason:'Product does not fit my needs.'};
 const signature=sign('sha256',Buffer.from(JSON.stringify(['veylo.refund.v2',request.purchaseId,request.nonce,request.destination,request.reason])),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 const refund=await api('/api/refunds',{request,signature});assert.equal(refund.status,201);
 assert.equal((await api('/api/seller/send-refund',{id:refund.data.id},b.cookie)).status,400);
 assert.equal((await api('/api/seller/decline-refund',{id:refund.data.id,reason:'Not yours'},b.cookie)).status,400);
 const sent=await drain(api('/api/seller/send-refund',{id:refund.data.id},a.cookie));assert.equal(sent.data.status,'broadcast');assert.equal(sendCount,1);
 assert.equal((await api('/api/seller/send-refund',{id:refund.data.id},a.cookie)).status,400);
});
