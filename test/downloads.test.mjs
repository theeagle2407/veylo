import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Store,receiptPayload} from '../core.mjs';
const pair=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function auth(s,id,key,purpose='veylo.download.v1'){const {nonce}=s.issueChallenge(id);const request={purchaseId:id,nonce};return [request,sign('sha256',Buffer.from(JSON.stringify([purpose,id,nonce])),{key,dsaEncoding:'ieee-p1363'}).toString('base64url')];}
test('downloads require the right purchase key and single-use purpose-bound authorization',()=>{
 const s=new Store(),a=pair(),b=pair();const p=s.createPurchase(a.publicKey.export({format:'jwk'}),'contour');s.simulatePayment(p.id);
 assert.throws(()=>s.authorizeDownload({},''));
 assert.throws(()=>s.authorizeDownload(...auth(s,p.id,b.privateKey)),/Invalid/);
 assert.throws(()=>s.authorizeDownload(...auth(s,p.id,a.privateKey,'veylo.status.v1')),/Invalid/);
 const ok=auth(s,p.id,a.privateKey);assert.equal(s.authorizeDownload(...ok),'contour');assert.throws(()=>s.authorizeDownload(...ok),/expired/);
 const other=s.createPurchase(b.publicKey.export({format:'jwk'}),'chime');s.simulatePayment(other.id);const cross=auth(s,p.id,a.privateKey);cross[0].purchaseId=other.id;assert.throws(()=>s.authorizeDownload(...cross),/expired/);
});
test('new receipts bind refund policy; legacy receipts and their access remain valid',()=>{
 const s=new Store(),a=pair(),p=s.createPurchase(a.publicKey.export({format:'jwk'}));const r=s.simulatePayment(p.id);assert(s.validateReceipt(r));assert.equal(r.downloadPolicy,'until-refund.v1');assert(!s.validateReceipt({...r,downloadPolicy:'forever'}));
 s.state.requests.q={purchaseId:p.id,status:'broadcast'};assert(s.downloadAllowed(p.id));s.state.requests.q.status='confirmed';assert(!s.downloadAllowed(p.id));assert.throws(()=>s.authorizeDownload(...auth(s,p.id,a.privateKey)),/refunded/);
 delete r.downloadPolicy;r.signature=sign(null,Buffer.from(receiptPayload(r)),s.state.secret).toString('base64url');assert(s.validateReceipt(r));assert(s.downloadAllowed(p.id));assert.equal(s.authorizeDownload(...auth(s,p.id,a.privateKey)),'fieldnotes');
});
test('expired download challenge is rejected',()=>{let now=1000;const s=new Store(undefined,()=>{},()=>now),a=pair(),p=s.createPurchase(a.publicKey.export({format:'jwk'}));s.simulatePayment(p.id);const proof=auth(s,p.id,a.privateKey);now+=120001;assert.throws(()=>s.authorizeDownload(...proof),/expired/);});
