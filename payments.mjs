import {getProduct} from './catalog.mjs';
import {randomBytes,sign,timingSafeEqual} from 'node:crypto';
import {product,receiptPayload} from './core.mjs';
import {findOutputs} from './wallet.mjs';
const CONFIRMATIONS=10;
export const testProduct={...product,asset:'TAZ'};
const value=100000; // 0.001 TAZ, integer zatoshis
export function shieldedTestAddress(s){return typeof s==='string'&&/^(utest1|ztestsapling1)[a-z0-9]{30,500}$/.test(s);}
export class Payments {
 constructor(store,wallet){this.store=store;this.wallet=wallet;store.state.usedPayments??={};}
 async create(key,productId="fieldnotes"){const selected=this.store.productLookup(productId);return this.wallet.exclusive(async()=>{
  const {stdout,stderr=''}=await this.wallet.run(['generate-address',this.wallet.config.account]);
  const address=stdout.match(/^\s*Address:\s*(utest1[a-z0-9]+)\s*$/m)?.[1];
  if(!address||!`${stdout}\n${stderr}`.includes('Network: testnet'))throw Error('Seller wallet must generate a testnet Unified Address.');
  const snapshot=await this.wallet.snapshot({fresh:true});
  const order=this.store.createPurchase(key,productId),p=this.store.state.purchases[order.id];
  p.payment={mode:'testnet',address,memo:'veylo:pay:'+randomBytes(24).toString('hex'),value:selected.value,token:randomBytes(32).toString('hex'),afterHeight:snapshot.height+1};
  this.store.persist();return {id:p.id,product:{...selected,asset:'TAZ'},paymentMode:'testnet',...p.payment,confirmationsRequired:CONFIRMATIONS};
 });}
 async check(id,token){return this.wallet.exclusive(async()=>{
  const p=this.store.state.purchases[id],invoice=p?.payment;
  if(!invoice||typeof token!=='string'||token.length!==invoice.token.length||!timingSafeEqual(Buffer.from(token),Buffer.from(invoice.token)))throw Error('Invalid checkout authorization.');
  const snapshot=await this.wallet.snapshot();
  const matches=findOutputs(snapshot,{account:this.wallet.config.account,memo:invoice.memo,value:invoice.value,direction:'receivedBy',afterHeight:invoice.afterHeight});
  if(matches.length>1)throw Error('Multiple matching payments; seller review required. Do not pay again.');
  const match=matches[0];
  if(!match||match.confirmations<CONFIRMATIONS)return {status:match?'confirming':'awaiting_payment',confirmations:match?.confirmations||0,confirmationsRequired:CONFIRMATIONS};
  const owner=this.store.state.usedPayments[match.key];if(owner&&owner!==p.id)throw Error('Payment output already used.');
  if(p.receipt){if(p.receipt.payment?.outputKey!==match.key)throw Error('Payment record differs from receipt.');return {status:'confirmed',receipt:p.receipt};}
  const proof={network:'testnet',txid:match.txid,pool:match.pool,outputIndex:match.index,outputKey:match.key,minedHeight:match.minedHeight,confirmationsAtIssue:match.confirmations};
  const product=p.item||getProduct();
  const r={schema:'veylo.purchase.v1',id:p.id,product:product.id,version:product.version,amount:product.price,asset:'TAZ',purchaseKey:p.key,issuedAt:new Date().toISOString(),paymentMode:'testnet',payment:proof};
  if(p.downloadPolicy)r.downloadPolicy=p.downloadPolicy;
  if(p.item?.delivery)r.delivery=structuredClone(p.item.delivery);
  r.signature=sign(null,Buffer.from(receiptPayload(r)),this.store.state.secret).toString('base64url');
  this.store.state.usedPayments[match.key]=p.id;p.receipt=r;p.status='paid_testnet';this.store.persist();return {status:'confirmed',receipt:r};
 });}
 async reconcile(q,snapshot){
  if(!q.memo)return q;
  const found=findOutputs(snapshot,{account:this.wallet.config.account,memo:q.memo,value:q.value,direction:'sentFrom',address:q.destination});
  if(found.length>1){q.status='needs_review';this.store.persist();return q;}
  const out=found[0];if(!out)return q;
  if(q.txid&&q.txid!==out.txid){q.status='needs_review';this.store.persist();return q;}
  q.txid=out.txid;q.confirmations=out.confirmations;q.status=out.confirmations>=CONFIRMATIONS?'confirmed':'broadcast';
  if(q.status==='confirmed')q.completedAt??=new Date().toISOString();
  this.store.persist();return q;
 }
 async refresh(){return this.wallet.exclusive(async()=>{
  const pending=Object.values(this.store.state.requests).filter(q=>['sending','unknown','broadcast'].includes(q.status));
  if(!pending.length)return {checked:0};
  const snapshot=await this.wallet.snapshot();for(const q of pending)await this.reconcile(q,snapshot);return {checked:pending.length};
 });}
 async refund(id){return this.wallet.exclusive(async()=>{
  const q=this.store.state.requests[id],p=this.store.state.purchases[q?.purchaseId];
  if(!q||p?.receipt?.paymentMode!=='testnet')throw Error('A testnet purchase is required.');
  if(q.status!=='requested')throw Error('Refund already attempted. Use Check confirmations; do not send again.');
  if(!shieldedTestAddress(q.destination))throw Error('Use a testnet shielded address.');
  // The wallet performs authoritative address decoding and network validation before sending.
  await this.wallet.snapshot({fresh:true});
  // Withdrawal may occur while the wallet snapshot is awaiting I/O.
  if(q.status!=='requested')throw Error('Refund request was withdrawn before payment processing.');
  q.value=p.payment?.value;if(!Number.isSafeInteger(q.value)||q.value<=0)throw Error('Invalid original payment amount.');q.memo='veylo:refund:'+q.id;q.status='sending';q.attemptedAt=new Date().toISOString();this.store.persist();
  try{q.txid=await this.wallet.send(q.destination,q.value,q.memo);q.status='broadcast';this.store.persist();return q;}
  catch{q.status='unknown';this.store.persist();throw Error('Refund outcome needs checking. No automatic retry will occur. Use Check confirmations and inspect the seller wallet.');}
 });}
}
