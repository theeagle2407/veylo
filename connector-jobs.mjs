import {randomUUID, createHash} from 'node:crypto';
import {Wallet} from './wallet.mjs';
const digest=token=>createHash('sha256').update(token).digest('hex');
export class ConnectorJobs {
 constructor(store,accounts,{timeout=120000}={}){this.store=store;this.accounts=accounts;this.timeout=timeout;store.state.connectorJobs??={};this.waiters=new Map();}
 actor(token){if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid connector credential.');const a=Object.values(this.accounts.data()).find(a=>a.connector?.hash===digest(token)&&a.connector.expiresAt>Date.now());if(!a)throw Error('Connector credential expired or revoked.');return a.id;}
 async request(actor,kind,input){
  const a=this.accounts.data()[actor];if(!a?.connector||a.connector.expiresAt<=Date.now()||Date.now()-a.connector.lastSeen>90000||a.connector.report?.protocol!==2)throw Error('Seller payment connector is offline.');
  const jobs=this.store.state.connectorJobs;
  for(const [id,j] of Object.entries(jobs))if(j.kind!=='send'&&Date.now()-j.createdAt>300000){delete jobs[id];}
  if(Object.values(jobs).filter(j=>j.actor===actor&&j.status==='queued').length>=20)throw Error('Seller connector is busy. Please retry shortly.');
  const job={id:randomUUID(),actor,kind,input,account:a.walletAccount,status:'queued',createdAt:Date.now(),credentialHash:a.connector.hash};
  jobs[job.id]=job;try{this.store.persist();}catch(e){delete jobs[job.id];throw e;}
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiters.delete(job.id);if(job.status==='queued'){job.status='expired';try{this.store.persist();}catch{}}reject(Error(kind==='send'?'Refund confirmation is pending. Do not retry the payment.':'Wallet check is taking longer than expected. Retry the status check.'));},this.timeout);this.waiters.set(job.id,{resolve,reject,timer});});
 }
 poll(token){const actor=this.actor(token);const hash=digest(token);return Object.values(this.store.state.connectorJobs).filter(j=>j.actor===actor&&j.credentialHash===hash&&j.status==='queued').map(j=>({id:j.id,kind:j.kind,account:j.account,input:j.input}));}
 claim(token,id){const actor=this.actor(token),j=this.store.state.connectorJobs[id];if(!j||j.actor!==actor||j.credentialHash!==digest(token))throw Error('Job not found.');if(j.status!=='queued')return {claimed:false};j.status='started';j.startedAt=Date.now();try{this.store.persist();}catch(e){j.status='queued';delete j.startedAt;throw e;}return {claimed:true};}
 complete(token,id,result){const actor=this.actor(token),j=this.store.state.connectorJobs[id];if(!j||j.actor!==actor||j.credentialHash!==digest(token))throw Error('Job not found.');if(j.status==='done')return {ok:true};if(j.status!=='started')throw Error('Job was not claimed.');
  if(!result||typeof result!=='object')throw Error('Invalid result.');
  j.status='done';j.result=result;j.completedAt=Date.now();try{this.store.persist();}catch(e){j.status='started';delete j.result;delete j.completedAt;throw e;}
  const w=this.waiters.get(id);if(w){clearTimeout(w.timer);this.waiters.delete(id);result.error?w.reject(Error('Seller wallet operation did not complete. Check the local connector.')):w.resolve(result.value);}
  return {ok:true};
 }
}
// A paired seller connector is trusted to report its own wallet evidence.
// Only outputs with this store's invoice/refund references are requested.
export class RemoteWallet extends Wallet {
 constructor(actor,jobs){super({});this.actor=actor;this.jobs=jobs;this.config={get account(){return jobs.accounts.data()[actor]?.walletAccount;}};}
 run(args){if(args[0]!=='generate-address'||args.length!==2||args[1]!==this.config.account)throw Error('Unsupported remote operation.');return this.jobs.request(this.actor,'address',{});}
 async readSnapshot(){
  const state=this.jobs.store.state;
  const purchases=Object.values(state.purchases).filter(p=>p.item?.sellerId===this.actor);
  const ids=new Set(purchases.map(p=>p.id));
  const memos=[...purchases.map(p=>p.payment?.memo),...Object.values(state.requests).filter(q=>ids.has(q.purchaseId)).map(q=>q.memo)].filter(Boolean);
  const value=await this.jobs.request(this.actor,'snapshot',{memos});
  if(!value||!Number.isSafeInteger(value.height)||value.height<1||!Array.isArray(value.transactions))throw Error('Invalid wallet snapshot.');
  for(const t of value.transactions){if(!/^[a-f0-9]{64}$/.test(t.txid)||!(t.minedHeight===null||Number.isSafeInteger(t.minedHeight)&&t.minedHeight>0&&t.minedHeight<=value.height)||!Array.isArray(t.outputs))throw Error('Invalid wallet transaction.');const indices=new Set();for(const o of t.outputs){if(!Number.isSafeInteger(o.index)||o.index<0||indices.has(o.index)||!Number.isSafeInteger(o.value)||o.value<0||!memos.includes(o.memo)||o.receivedBy!==this.config.account&&o.sentFrom!==this.config.account)throw Error('Invalid wallet output.');indices.add(o.index);}}
  return value;
 }
 async send(address,value,memo){this.invalidateSnapshot();try{const txid=await this.jobs.request(this.actor,'send',{address,value,memo});if(!/^[a-f0-9]{64}$/.test(txid))throw Error('Missing transaction ID.');return txid;}finally{this.invalidateSnapshot();}}
}
