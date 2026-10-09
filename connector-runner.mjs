import fs from 'node:fs';
import path from 'node:path';
// Disk journal is written before any send. An uncertain operation is never repeated.
export class ConnectorRunner {
 constructor({wallet,journalPath,approve,request}){this.wallet=wallet;this.path=journalPath;this.approve=approve;this.request=request;this.journal=fs.existsSync(journalPath)?JSON.parse(fs.readFileSync(journalPath,'utf8')):{};}
 save(){fs.mkdirSync(path.dirname(this.path),{recursive:true,mode:0o700});const tmp=this.path+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.journal),{mode:0o600});const fd=fs.openSync(tmp,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,this.path);}
 async run(job){
  if(job.account!==this.wallet.config.account)throw Error('Store wallet account differs from this connector.');
  if(!['address','snapshot','send'].includes(job.kind))throw Error('Unsupported connector operation.');
  const prior=this.journal[job.id];
  if(prior){await this.request('/api/connector/complete',{id:job.id,result:prior.result||{error:'An earlier attempt has an unknown outcome. No repeat send.'}});return;}
  const claim=await this.request('/api/connector/claim',{id:job.id});if(!claim.claimed)return;
  this.journal[job.id]={startedAt:Date.now()};this.save();
  let result;
  try{
   let value;
   if(job.kind==='address')value=await this.wallet.run(['generate-address',this.wallet.config.account]);
   if(job.kind==='snapshot'){
    const memos=job.input?.memos;
    if(!Array.isArray(memos)||memos.length>10000||memos.some(m=>typeof m!=='string'||!/^veylo:(pay|refund):[a-z0-9-]{1,100}$/.test(m)))throw Error('Invalid payment references.');
    const snapshot=await this.wallet.snapshot({fresh:true});
    value={height:snapshot.height,transactions:snapshot.transactions.map(t=>({...t,outputs:t.outputs.filter(o=>memos.includes(o.memo)&&(o.receivedBy===job.account||o.sentFrom===job.account))})).filter(t=>t.outputs.length)};
   }
   if(job.kind==='send'){
    const {address,value:amount,memo}=job.input||{};
    if(typeof address!=='string'||!/^(utest1|ztestsapling1)[a-z0-9]{30,500}$/.test(address)||!Number.isSafeInteger(amount)||amount<=0||amount>100000000000000||!/^veylo:refund:[a-f0-9-]{36}$/.test(memo))throw Error('Invalid refund instruction.');
    if(!this.wallet.config.identity)throw Error('Configure a local identity before approving refunds.');
    if(!await this.approve({address,value:amount,memo}))throw Error('Refund declined in local connector.');
    await this.wallet.snapshot({fresh:true});
    value=await this.wallet.send(address,amount,memo);
   }
   result={value};
  }catch{result={error:'Wallet operation failed, was declined, or has an unknown outcome. Inspect locally before any further action.'};}
  this.journal[job.id].result=result;this.save();
  await this.request('/api/connector/complete',{id:job.id,result});
 }
 async flush(){for(const [id,entry] of Object.entries(this.journal)){if(entry.acknowledged)continue;try{await this.request('/api/connector/complete',{id,result:entry.result||{error:'Interrupted operation. No automatic repeat.'}});entry.acknowledged=true;this.save();}catch{/* Retain for reconciliation; do not block later read-only jobs. */}}}
}
