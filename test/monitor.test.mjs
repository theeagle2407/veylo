import test from 'node:test';
import assert from 'node:assert/strict';
import {startRefundMonitor} from '../monitor.mjs';
test('monitor checks immediately, waits for completion, retries errors and stops',async()=>{
 const queue=[];let complete,calls=0,errors=0,cancelled;
 const payments={refresh:()=>{calls++;return new Promise(resolve=>{complete=resolve;});}};
 const stop=startRefundMonitor(payments,{schedule:(fn,ms)=>{queue.push({fn,ms});return queue.length;},cancel:id=>cancelled=id,onError:()=>errors++});
 assert.equal(queue[0].ms,0);const running=queue.shift().fn();assert.equal(calls,1);assert.equal(queue.length,0);
 complete();await running;assert.equal(queue[0].ms,15000);
 payments.refresh=async()=>{throw Error('offline');};await queue.shift().fn();assert.equal(errors,1);assert.equal(queue.length,1);
 const final=queue.shift().fn();stop();await final;assert.equal(queue.length,0);assert.ok(cancelled);
});
