import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const TX=/^[a-f0-9]{64}$/;
export function zatoshis(value){
 const m=/^(\d+)\.(\d{8}) TAZ$/.exec(value.trim());
 if(!m)throw Error('Unexpected wallet amount format.');
 const n=BigInt(m[1])*100000000n+BigInt(m[2]);
 if(n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Wallet amount is too large.');
 return Number(n);
}
export function parseTransactions(text){
 const transactions=[];let tx=null,out=null,started=false;
 for(const original of text.split(/\r?\n/)){
  const line=original.trim();if(!line)continue;
  if(line==='Transactions:'){if(started)throw Error('Duplicate transaction header.');started=true;continue;}
  if(!started)throw Error('Unexpected wallet output before Transactions.');
  if(TX.test(line)){tx={txid:line,minedHeight:null,outputs:[]};transactions.push(tx);out=null;continue;}
  if(!tx)throw Error('Unexpected transaction listing.');
  let m;
  if((m=/^Mined: (\d+) \(.+\)$/.exec(line))){tx.minedHeight=Number(m[1]);continue;}
  if(line==='Mined: Not mined'||line==='Mined: Unmined')continue;
  if((m=/^Output (\d+) \((Ironwood|Orchard|Sapling|Transparent)\)$/.exec(line))){out={index:Number(m[1]),pool:m[2],change:false};tx.outputs.push(out);continue;}
  if((m=/^Value:\s+(\d+\.\d{8} TAZ)( \(Change\))?$/.exec(line))&&out){out.value=zatoshis(m[1]);out.change=!!m[2];continue;}
  if((m=/^(Received by|Sent from) account: ([a-f0-9-]{36}) \([^\r\n]*\)$/.exec(line))&&out){out[m[1]==='Received by'?'receivedBy':'sentFrom']=m[2];continue;}
  if(line.startsWith('To: ')&&out){out.address=line.slice(4);continue;}
  if(line.startsWith('Memo: Memo::Text(')&&out){
   const raw=line.slice('Memo: Memo::Text('.length,-1);
   if(!line.endsWith(')'))throw Error('Malformed memo.');
   // Only one printable ASCII memo can authorize a Veylo transaction.
   // Rust escapes stay literal here; escaped/multiline/unicode memos never match.
   out.memo=/^"[\x20-\x21\x23-\x5b\x5d-\x7e]*"$/.test(raw)?raw.slice(1,-1):null;
   continue;
  }
  if(line==='Memo: Memo::Empty'&&out){out.memo=null;continue;}
  if(line.startsWith('Memo: ')&&out){out.memo=null;continue;}
  if(/^Amount:\s+/.test(line)||/^Fee paid:\s+/.test(line)||/^Sent \d+ notes, received \d+ notes, \d+ memos$/.test(line))continue;
  throw Error('Wallet output format changed; payment verification stopped.');
 }
 if(!started)throw Error('Missing wallet transaction header.');
 const seen=new Set();
 for(const t of transactions){if(seen.has(t.txid))throw Error('Duplicate transaction.');seen.add(t.txid);const outputs=new Set();for(const o of t.outputs){const id=o.pool+':'+o.index;if(outputs.has(id)||!Number.isSafeInteger(o.value))throw Error('Invalid wallet output.');outputs.add(id);}}
 return transactions;
}
export function findOutputs(snapshot,{account,memo,value,direction,address,afterHeight=0}){
 return snapshot.transactions.flatMap(t=>t.outputs.filter(o=>
  !o.change&&['Ironwood','Orchard','Sapling'].includes(o.pool)&&o[direction]==account&&
  o.memo===memo&&o.value===value&&(!address||o.address===address)&&
  (t.minedHeight===null||t.minedHeight>=afterHeight)
 ).map(o=>({...o,txid:t.txid,minedHeight:t.minedHeight,
  confirmations:t.minedHeight===null?0:Math.max(0,snapshot.height-t.minedHeight+1),
  key:`testnet:${t.txid}:${o.pool}:${o.index}`})));
}
export class Wallet {
 constructor(config,{clock=()=>Date.now()}={}){this.config=config;this.tail=Promise.resolve();this.clock=clock;this.cachedSnapshot=null;this.snapshotPending=null;this.generation=0;}
 exclusive(fn){const next=this.tail.then(fn,fn);this.tail=next.catch(()=>{});return next;}
 async run(args){
  const {stdout,stderr}=await execute(this.config.binary,['wallet','-w',this.config.directory,...args],{timeout:180000,maxBuffer:16*1024*1024,env:{...process.env,NO_COLOR:'1'}});
  return {stdout,stderr};
 }
 invalidateSnapshot(){this.generation++;this.cachedSnapshot=null;}
 async snapshot({fresh=false}={}){
  const cache=this.cachedSnapshot;
  if(!fresh&&cache&&this.clock()>=cache.finishedAt&&this.clock()-cache.finishedAt<10000)return structuredClone(cache.value);
  if(this.snapshotPending)return structuredClone(await this.snapshotPending);
  const generation=this.generation;
  const pending=this.readSnapshot().then(value=>{
   if(this.generation===generation)this.cachedSnapshot={value:structuredClone(value),finishedAt:this.clock()};
   return value;
  },error=>{this.cachedSnapshot=null;throw error;});
  this.snapshotPending=pending;
  try{return structuredClone(await pending);}finally{if(this.snapshotPending===pending)this.snapshotPending=null;}
 }
 async readSnapshot(){
  const sync=await this.run(['sync','--server','zecrocks']);
  const heights=[...(`${sync.stdout}\n${sync.stderr}`).matchAll(/Latest block height is (\d+)/g)];
  if(heights.length!==1)throw Error('Cannot determine synced testnet height.');
  await this.run(['enhance','--server','zecrocks']);
  const list=await this.run(['list-tx']);
  const transactions=parseTransactions(list.stdout);
  const ids=JSON.parse((await this.run(['list-tx','--json'])).stdout);
  if(!Array.isArray(ids)||ids.length!==transactions.length||transactions.some(t=>!ids.some(j=>j.txid===t.txid&&j.mined_height===t.minedHeight)))throw Error('Wallet transaction metadata does not agree.');
  return {height:Number(heights[0][1]),transactions};
 }
 async send(address,value,memo){
  this.invalidateSnapshot();
  try{
  const result=await this.run(['send',this.config.account,'--identity',this.config.identity,'--address',address,'--value',String(value),'--memo',memo,'--server','zecrocks']);
  const ids=result.stdout.split(/\r?\n/).map(s=>s.trim()).filter(s=>TX.test(s));
  if(ids.length!==1)throw Error('No unambiguous transaction ID returned.');
  return ids[0];
  }finally{this.invalidateSnapshot();}
 }
}
