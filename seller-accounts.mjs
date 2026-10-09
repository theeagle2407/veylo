import {createHash, randomBytes, randomUUID, scrypt as derive, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt = promisify(derive);
const clean = (value, max, label) => {
 if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw Error(`Enter a valid ${label}.`);
 return value.trim();
};
export class SellerAccounts {
 constructor(store) { this.store=store; this.sessions=new Map(); this.busy=false; }
 data() { return this.store.state.sellerAccounts || {}; }
 commit(next) { const old=this.store.state.sellerAccounts; this.store.state.sellerAccounts=next; try { this.store.persist(); } catch(e) { this.store.state.sellerAccounts=old; throw e; } }
 async register(input) {
  if(this.busy) throw Error('Please try again in a moment.');
  this.busy=true;
  try {
   const username=clean(input.username,40,'username').toLowerCase();
   if(!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(username)) throw Error('Use 3–40 letters, numbers, underscores or hyphens.');
   const name=clean(input.name,60,'store name');
   if(typeof input.password!=='string'||input.password.length<14||input.password.length>128) throw Error('Use a password of 14–128 characters.');
   if(Object.values(this.data()).some(a=>a.username===username)) throw Error('That username is unavailable.');
   const salt=randomBytes(16).toString('hex'), hash=(await scrypt(input.password,salt,64)).toString('hex');
   const account={id:randomUUID(),username,name,bio:'',salt,hash,drafts:[],createdAt:new Date().toISOString()};
   this.commit({...this.data(),[account.id]:account}); return this.session(account.id);
  } finally {this.busy=false;}
 }
 async login(input) {
  if(this.busy) throw Error('Please try again in a moment.');
  this.busy=true;
  try {
   if(typeof input.password!=='string'||input.password.length>128) throw Error('Username or password is incorrect.');
   const a=Object.values(this.data()).find(a=>a.username===String(input.username).trim().toLowerCase());
   const hash=await scrypt(input.password,a?.salt||'veylo-missing-account',64);
   if(!a||!timingSafeEqual(hash,Buffer.from(a.hash,'hex'))) throw Error('Username or password is incorrect.');
   return this.session(a.id);
  } finally {this.busy=false;}
 }
 session(id) {const token=randomBytes(32).toString('hex'); for(const [k,v] of this.sessions) if(v.until<Date.now())this.sessions.delete(k); this.sessions.set(token,{id,until:Date.now()+8*3600000});return token;}
 actor(token) {const s=this.sessions.get(token);if(!s||s.until<=Date.now()||!this.data()[s.id])throw Error('Seller sign-in required.');return s.id;}
 view(id) {const a=this.data()[id];if(!a)throw Error('Seller not found.');return {id:a.id,username:a.username,name:a.name,bio:a.bio,drafts:structuredClone(a.drafts),walletStatus:!a.connector?'not_connected':a.connector.expiresAt<=Date.now()?'expired':!a.connector.lastSeen?'awaiting_connector':Date.now()-a.connector.lastSeen<90000?'online':'offline',wallet:a.connector?.report||null,canPublish:!!(a.connector?.expiresAt>Date.now()&&a.connector.report?.protocol===2&&Date.now()-a.connector.lastSeen<90000)};}
 profile(id,input) {this.view(id);const next=structuredClone(this.data());next[id].name=clean(input.name,60,'store name');next[id].bio=clean(input.bio,500,'store description');this.commit(next);return this.view(id);}
 draft(id,input) {this.view(id);const next=structuredClone(this.data());if(next[id].drafts.length>=30)throw Error('This store supports up to 30 drafts.');const name=clean(input.name,80,'product name'),description=clean(input.description,1000,'product description');next[id].drafts.push({id:randomUUID(),name,description,status:'draft'});this.commit(next);return this.view(id);}
 pair(id) {
  this.view(id);const next=structuredClone(this.data()),token=randomBytes(32).toString('hex');
  next[id].connector={hash:createHash('sha256').update(token).digest('hex'),createdAt:Date.now(),expiresAt:Date.now()+30*86400000,lastSeen:null};this.commit(next);
  return {token,expiresAt:next[id].connector.expiresAt};
 }
 disconnect(id) {this.view(id);const next=structuredClone(this.data());delete next[id].connector;this.commit(next);return this.view(id);}
 heartbeat(token,report) {
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid connector credential.');
  const hash=createHash('sha256').update(token).digest('hex');
  const a=Object.values(this.data()).find(a=>a.connector?.hash===hash&&a.connector.expiresAt>Date.now());
  if(!a)throw Error('Connector credential expired or revoked.');
  if(report?.network!=='test'||!Number.isSafeInteger(report.height)||report.height<1||typeof report.account!=='string'||!/^[a-f0-9-]{36}$/.test(report.account))throw Error('Invalid testnet wallet report.');
  if(a.walletAccount&&a.walletAccount!==report.account)throw Error('This store is bound to a different wallet account.');
  const next=structuredClone(this.data());next[a.id].walletAccount=report.account;next[a.id].connector.lastSeen=Date.now();
  next[a.id].connector.report={network:'test',height:report.height,account:report.account,protocol:report.protocol===2?2:1};this.commit(next);
  return {ok:true,storeName:a.name,canPublish:this.view(a.id).canPublish};
 }

}
