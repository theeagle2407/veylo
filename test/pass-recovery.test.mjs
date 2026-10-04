import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {generateKeyPairSync,webcrypto,sign} from 'node:crypto';
import {Store,requestPayload} from '../core.mjs';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const restoreCode=source.slice(source.indexOf('async function restore('),source.indexOf("app.addEventListener('click',async event=>"));
const payloadCode=source.split('\n').find(s=>s.startsWith('const receiptPayload='));
function fixture(){const store=new Store(),keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const p=store.createPurchase(keys.publicKey.export({format:'jwk'}));const receipt=store.simulatePayment(p.id);return {store,keys,pass:{schema:'veylo.pass.v1',merchantKey:store.state.publicKey,receipt,privateKey:keys.privateKey.export({format:'jwk'})}};}
async function restore(pass,merchantKey,{size}={}){
 const saved=[],messages=[];const context=vm.createContext({crypto:webcrypto,Uint8Array,catalog:{merchantKey},bytes:s=>new TextEncoder().encode(s),un64:s=>Buffer.from(s,'base64url'),keep:p=>saved.push(p),buyer:async()=>{},toast:s=>messages.push(s)});
 vm.runInContext(payloadCode+'\n'+restoreCode,context);
 const text=typeof pass==='string'?pass:JSON.stringify(pass);await context.restore({target:{files:[{size:size??Buffer.byteLength(text),text:async()=>text}]}});return {saved,messages};
}
test('actual browser restore validates a portable pass and its restored key authorizes a download',async()=>{
 const f=fixture(),r=await restore(f.pass,f.store.state.publicKey);assert.equal(r.saved.length,1);assert.equal(r.messages.at(-1),'Purchase restored.');
 const p=r.saved[0],c=f.store.issueChallenge(p.receipt.id),request={purchaseId:p.receipt.id,nonce:c.nonce};
 const key=await webcrypto.subtle.importKey('jwk',p.privateKey,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const sig=await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(JSON.stringify(['veylo.download.v1',request.purchaseId,request.nonce])));
 assert.equal(f.store.authorizeDownload(request,Buffer.from(sig).toString('base64url')),'fieldnotes');
});
test('browser restore rejects altered receipts, foreign issuers, and substituted purchase keys',async()=>{
 const f=fixture(),other=fixture();
 for(const [pass,issuer] of [[{...f.pass,receipt:{...f.pass.receipt,amount:'999'}},f.store.state.publicKey],[f.pass,other.store.state.publicKey],[{...f.pass,privateKey:other.pass.privateKey},f.store.state.publicKey],[{...f.pass,merchantKey:other.store.state.publicKey,receipt:other.pass.receipt,privateKey:other.pass.privateKey},f.store.state.publicKey]]){
  const r=await restore(pass,issuer);assert.equal(r.saved.length,0);assert.ok(r.messages.length);
 }
});
test('browser restore rejects malformed and oversized files before saving',async()=>{
 const f=fixture();for(const [pass,options] of [['invalid json',{}],[{},{}],[f.pass,{size:20001}]])assert.equal((await restore(pass,f.store.state.publicKey,options)).saved.length,0);
});
test('restoring a refunded pass does not restore revoked downloads',async()=>{
 const f=fixture(),req={purchaseId:f.pass.receipt.id,nonce:f.store.issueChallenge(f.pass.receipt.id).nonce,destination:'simulated-receiving-address',reason:'Not suitable'};
 const signature=sign('sha256',Buffer.from(requestPayload(req)),{key:f.keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');const q=f.store.requestRefund(req,signature);f.store.simulateRefund(q.id);
 const r=await restore(f.pass,f.store.state.publicKey);assert.equal(r.saved.length,1);assert.equal(f.store.downloadAllowed(r.saved[0].receipt.id),false);
});
