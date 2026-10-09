import test from 'node:test';
import assert from 'node:assert/strict';
import {SellerAccounts} from '../seller-accounts.mjs';
test('connector credentials are seller scoped, revocable, persisted as hashes and cannot enable publication',async()=>{
 const store={state:{},persist(){}};const accounts=new SellerAccounts(store);
 const alice=accounts.actor(await accounts.register({username:'alice',name:'Alice',password:'long private password'}));
 const bob=accounts.actor(await accounts.register({username:'bob',name:'Bob',password:'another long password'}));
 const paired=accounts.pair(alice),report={network:'test',height:123,account:'6be4ea81-7f3a-44ee-9801-312ec18976e3'};
 assert(!JSON.stringify(store.state).includes(paired.token));
 assert.throws(()=>accounts.heartbeat(paired.token,{...report,network:'main'}));
 assert.equal(accounts.heartbeat(paired.token,report).storeName,'Alice');
 assert.equal(accounts.view(alice).walletStatus,'online');assert.equal(accounts.view(bob).walletStatus,'not_connected');
 assert.equal(accounts.view(alice).canPublish,false);
 const restarted=new SellerAccounts({state:JSON.parse(JSON.stringify(store.state)),persist(){}});
 assert.equal(restarted.heartbeat(paired.token,report).ok,true);
 restarted.disconnect(alice);assert.throws(()=>restarted.heartbeat(paired.token,report));
 const rotated=accounts.pair(alice);assert.throws(()=>accounts.heartbeat(paired.token,report));
 accounts.data()[alice].connector.expiresAt=0;assert.throws(()=>accounts.heartbeat(rotated.token,report));
});
