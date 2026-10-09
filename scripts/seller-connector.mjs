import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {Wallet} from '../wallet.mjs';
import {ConnectorRunner} from '../connector-runner.mjs';
const folder=path.join(os.homedir(),'.veylo-connector');
const config=JSON.parse(fs.readFileSync(path.join(folder,'config.json'),'utf8'));
const site=new URL(config.site);
if(site.protocol!=='https:'||site.username||site.password||site.pathname!=='/'||site.search||site.hash)throw Error('Use an HTTPS website origin.');
// Lock out a second sender. After an unclean exit inspect the prior process before removing the lock.
const lock=path.join(folder,'running.lock');
try{fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});}catch{throw Error('Another connector may be running. Stop it first. If it crashed, check the PID in ~/.veylo-connector/running.lock before removing that lock file.');}
process.on('exit',()=>{try{fs.unlinkSync(lock);}catch{}});
let stopping=false;process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
const wallet=new Wallet({binary:config.binary,directory:config.wallet,account:config.account,identity:config.identity});
async function request(route,body){const response=await fetch(new URL(route,site),{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error(`Connector request rejected (${response.status}). Check pairing and backend availability.`);return response.json();}
const runner=new ConnectorRunner({wallet,journalPath:path.join(folder,'operations.json'),request,approve:async({address,value,memo})=>{
 const rl=createInterface({input:process.stdin,output:process.stdout});
 try{console.log(`\nREFUND REQUEST\nAmount: ${value} zatoshis plus network fee\nDestination: ${address}\nReference: ${memo}`);return (await rl.question('Type SEND to approve this exact refund, or press Enter to decline: ')).trim()==='SEND';}finally{rl.close();}
}});
console.log('Veylo payment connector. Keep this terminal open. Refunds require local SEND approval.');
let lastReport=0;
while(!stopping){
 try {
  if(Date.now()-lastReport>30000){
   const report=JSON.parse((await wallet.run(['get-info','--server','zecrocks'])).stdout);
   if(report.chain_name!=='test')throw Error('A compatible testnet wallet is required.');
   const listing=await wallet.run(['list-accounts']);if(!listing.stdout.includes(config.account))throw Error('Account not found in the selected wallet.');
   const result=await request('/api/connector/heartbeat',{network:'test',height:report.chain_tip_height,account:config.account,protocol:2});lastReport=Date.now();console.log(`Connected to ${result.storeName}; chain height ${report.chain_tip_height}.`);
  }
  await runner.flush();
  const {jobs}=await request('/api/connector/poll',{});
  for(const job of jobs){if(stopping)break;await runner.run(job);}
 }catch(e){console.error(e.message?.startsWith('Command failed')?'Local wallet check failed. Check the wallet and network.':e.message);}
 for(let i=0;i<3&&!stopping;i++)await new Promise(r=>setTimeout(r,1000));
}
