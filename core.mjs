import {getProduct} from './catalog.mjs';
import { randomUUID, randomBytes, generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
export const product = {id:'fieldnotes',name:'Fieldnotes',version:'1.0',description:'A printable field journal for observations, sketches, and independent research.',price:'0.001',asset:'ZEC',kind:'Digital journal',seller:'Field Studio'};
const fail = message => { throw new Error(message); };
export function newState(){ const keys=generateKeyPairSync('ed25519'); return {schema:1,secret:keys.privateKey.export({type:'pkcs8',format:'pem'}),publicKey:keys.publicKey.export({format:'jwk'}),purchases:{},challenges:{},requests:{},notices:[]}; }
export function receiptPayload(r){return JSON.stringify([r.schema,r.id,r.product,r.version,r.amount,r.asset,r.purchaseKey,r.issuedAt,r.paymentMode,...(r.paymentMode==='testnet'?[r.payment]:[]),...(r.downloadPolicy?[r.downloadPolicy]:[]),...(r.delivery?[r.delivery]:[])]);}
export function requestPayload(r){return JSON.stringify(r.reason===undefined?['veylo.refund.v1',r.purchaseId,r.nonce,r.destination]:['veylo.refund.v2',r.purchaseId,r.nonce,r.destination,r.reason]);}
export class Store {
 constructor(state=newState(),save=()=>{},clock=()=>Date.now()){this.state=state;this.save=save;this.clock=clock;this.productLookup=getProduct;}
 persist(){this.save(this.state);}
 createPurchase(jwk,productId="fieldnotes"){
  const product=this.productLookup(productId);
  if(!jwk || jwk.kty!=='EC'||jwk.crv!=='P-256'||jwk.d)fail('A public P-256 purchase key is required.');
  const key=createPublicKey({key:{kty:jwk.kty,crv:jwk.crv,x:jwk.x,y:jwk.y},format:'jwk'}).export({format:'jwk'});
  const id=randomUUID(); this.state.purchases[id]={id,key,item:product,downloadPolicy:'until-refund.v1',status:'awaiting_payment',createdAt:this.clock()};this.persist();return {id,product,paymentMode:'simulation'};
 }
 simulatePayment(id){
  const p=this.state.purchases[id];if(!p)fail('Purchase not found.');
  if(p.payment?.mode==='testnet')fail('Testnet purchases require wallet verification.');if(p.receipt)return p.receipt;
  const product=p.item||getProduct();
  const r={schema:'veylo.purchase.v1',id,product:product.id,version:product.version,amount:product.price,asset:product.asset,purchaseKey:p.key,issuedAt:new Date(this.clock()).toISOString(),paymentMode:'simulation'};
  if(p.downloadPolicy)r.downloadPolicy=p.downloadPolicy;
  if(p.item?.delivery)r.delivery=structuredClone(p.item.delivery);
  r.signature=sign(null,Buffer.from(receiptPayload(r)),this.state.secret).toString('base64url');p.receipt=r;p.status='paid_simulation';this.persist();return r;
 }
 validateReceipt(r){try{return r?.schema==='veylo.purchase.v1'&&verify(null,Buffer.from(receiptPayload(r)),createPublicKey({key:this.state.publicKey,format:'jwk'}),Buffer.from(r.signature,'base64url'));}catch{return false;}}
 issueChallenge(id){
  const p=this.state.purchases[id];if(!p?.receipt)fail('Confirmed purchase required.');
  const nonce=randomBytes(32).toString('base64url');
  for(const [n,c] of Object.entries(this.state.challenges))if(c.expiresAt<this.clock())delete this.state.challenges[n];
  this.state.challenges[nonce]={purchaseId:id,expiresAt:this.clock()+120000};this.persist();return {nonce,expiresAt:this.clock()+120000};
 }
 purchaseStatus(r,signature){
  const c=this.state.challenges[r.nonce],p=this.state.purchases[r.purchaseId];
  if(!c||!p?.receipt||c.purchaseId!==r.purchaseId||c.expiresAt<=this.clock())fail('Status authorization expired.');
  const payload=JSON.stringify(['veylo.status.v1',r.purchaseId,r.nonce]);
  if(!verify('sha256',Buffer.from(payload),{key:createPublicKey({key:p.key,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')))fail('Invalid status authorization.');
  delete this.state.challenges[r.nonce];this.persist();
  const requests=Object.values(this.state.requests).filter(q=>q.purchaseId===r.purchaseId);
  const q=requests.find(q=>q.status!=='withdrawn')||requests.at(-1);
  return {review:this.state.reviews?.[r.purchaseId]||null,downloadAllowed:this.downloadAllowed(r.purchaseId),refund:q?{decisionReason:q.decisionReason,decidedAt:q.decidedAt,id:q.id,withdrawnAt:q.withdrawnAt,asset:p.receipt.asset,status:q.status,reason:q.reason,destination:q.destination,attemptedAt:q.attemptedAt,createdAt:q.createdAt,completedAt:q.completedAt,amount:q.amount,txid:q.txid,confirmations:q.confirmations}:null};
 }
 publicReviews(){return Object.values(this.state.reviews||{}).map(r=>({id:r.id,product:r.product,rating:r.rating,text:r.text,updatedAt:r.updatedAt,paymentMode:r.paymentMode})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
 writeReview(r,signature){
  const c=this.state.challenges[r?.nonce],p=this.state.purchases[r?.purchaseId];
  if(!c||!p?.receipt||c.purchaseId!==r.purchaseId||c.expiresAt<=this.clock())fail('Review authorization expired or already used.');
  if(!Number.isInteger(r.rating)||r.rating<1||r.rating>5||typeof r.text!=='string'||!r.text.trim()||r.text.length>1000)fail('Choose 1–5 stars and write a review of up to 1,000 characters.');
  const payload=JSON.stringify(['veylo.review.v1',r.purchaseId,r.nonce,r.rating,r.text]);
  if(!verify('sha256',Buffer.from(payload),{key:createPublicKey({key:p.key,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')))fail('Invalid review authorization.');
  this.state.reviews??={};const existing=this.state.reviews[p.id];
  this.state.reviews[p.id]={id:existing?.id||randomUUID(),product:p.receipt.product,rating:r.rating,text:r.text.trim(),updatedAt:new Date(this.clock()).toISOString(),paymentMode:p.receipt.paymentMode};
  delete this.state.challenges[r.nonce];this.persist();return {ok:true};
 }
 downloadAllowed(id){
  const p=this.state.purchases[id];if(!p?.receipt)return false;
  return p.receipt.downloadPolicy!=='until-refund.v1'||!Object.values(this.state.requests).some(q=>q.purchaseId===id&&['confirmed','simulated'].includes(q.status));
 }
 authorizeDownload(r,signature){
  const c=this.state.challenges[r?.nonce],p=this.state.purchases[r?.purchaseId];
  if(!c||!p?.receipt||c.purchaseId!==r.purchaseId||c.expiresAt<=this.clock())fail('Download authorization expired or already used.');
  const payload=JSON.stringify(['veylo.download.v1',r.purchaseId,r.nonce]);
  if(!verify('sha256',Buffer.from(payload),{key:createPublicKey({key:p.key,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')))fail('Invalid download authorization.');
  delete this.state.challenges[r.nonce];this.persist();
  if(!this.downloadAllowed(p.id))fail('This purchase was refunded. Future downloads have ended.');
  return p.receipt.product;
 }
 requestRefund(r,signature){
  const c=this.state.challenges[r.nonce],p=this.state.purchases[r.purchaseId];
  if(!c||!p?.receipt||c.purchaseId!==r.purchaseId||c.expiresAt<=this.clock())fail('Request expired or already used.');
  if(typeof r.destination!=='string'||r.destination.length<8||r.destination.length>512||/\s/.test(r.destination))fail('Enter a receiving address without spaces.');
  // Simulation deliberately does not claim to validate a Zcash address or network.
  const valid=verify('sha256',Buffer.from(requestPayload(r)),{key:createPublicKey({key:p.key,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url'));
  if(!valid)fail('Purchase signature does not match this destination.');
  if(Object.values(this.state.requests).some(q=>q.purchaseId===r.purchaseId&&q.status!=='withdrawn'))fail('A refund request already exists for this purchase.');
  if(r.reason!==undefined&&(typeof r.reason!=='string'||!r.reason.trim()||r.reason.length>1000))fail('Write a refund reason of up to 1,000 characters.');
  delete this.state.challenges[r.nonce];
  const q={id:randomUUID(),purchaseId:r.purchaseId,destination:r.destination,reason:r.reason?.trim()||'',status:'requested',createdAt:new Date(this.clock()).toISOString(),amount:p.receipt.amount};
  this.state.requests[q.id]=q;this.persist();return q;
 }
 withdrawRefund(r,signature){
  const c=this.state.challenges[r?.nonce],p=this.state.purchases[r?.purchaseId],q=this.state.requests[r?.requestId];
  if(!c||!p?.receipt||c.purchaseId!==r.purchaseId||c.expiresAt<=this.clock())fail('Withdrawal authorization expired or already used.');
  const payload=JSON.stringify(['veylo.refund.withdraw.v1',r.purchaseId,r.nonce,r.requestId]);
  if(!verify('sha256',Buffer.from(payload),{key:createPublicKey({key:p.key,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')))fail('Invalid withdrawal signature.');
  if(!q||q.purchaseId!==p.id)fail('Refund request not found for this purchase.');
  if(q.status!=='requested'||q.attemptedAt||q.txid||q.memo)fail('This request can no longer be withdrawn. Payment processing may have started.');
  q.status='withdrawn';q.withdrawnAt=new Date(this.clock()).toISOString();delete this.state.challenges[r.nonce];this.persist();return {ok:true,status:q.status};
 }
 declineRefund(id,reason){
  const q=this.state.requests[id];
  if(!q||q.status!=='requested'||q.attemptedAt||q.txid||q.memo)fail('Only an unprocessed refund request can be declined.');
  if(typeof reason!=='string'||!reason.trim()||reason.length>1000)fail('Explain the decision in up to 1,000 characters.');
  q.status='declined';q.decisionReason=reason.trim();q.decidedAt=new Date(this.clock()).toISOString();this.persist();return {ok:true,status:q.status};
 }
 publishNotice({title,body,productId="fieldnotes"}){
  const product=this.productLookup(productId,true);
  if(typeof title!=='string'||!title.trim()||title.length>120||typeof body!=='string'||!body.trim()||body.length>2000)fail('A title and message are required.');
  const notice={id:randomUUID(),product:product.id,version:product.version,title:title.trim(),body:body.trim(),refundAvailable:true,createdAt:new Date(this.clock()).toISOString()};
  this.state.notices.unshift(notice);this.persist();return notice;
 }
 simulateRefund(id){const q=this.state.requests[id];if(!q)fail('Request not found.');if(this.state.purchases[q.purchaseId]?.receipt?.paymentMode==='testnet')fail('Testnet refunds require wallet payment.');if(q.status!=='requested')fail('This request has already been processed.');q.status='simulated';q.completedAt=new Date(this.clock()).toISOString();q.simulationId=randomUUID();this.persist();return q;}
}
