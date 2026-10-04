// Reconciliation only: this monitor never creates or resends a payment.
export function startRefundMonitor(payments,{delay=15000,schedule=setTimeout,cancel=clearTimeout,onError=()=>{}}={}){
 let stopped=false,timer;
 async function tick(){
  try{await payments.refresh();}catch(error){onError(error);}
  finally{if(!stopped)timer=schedule(tick,delay);}
 }
 timer=schedule(tick,0);
 return ()=>{stopped=true;cancel(timer);};
}
