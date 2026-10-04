// Observation only: never creates invoices, signs, or sends payments.
export function watchPayment({check,onResult,onError,onBusy=()=>{},active=()=>true,delay=15000,schedule=setTimeout,cancel=clearTimeout}){
 let stopped=false,busy=false,timer;
 async function tick(){
  if(stopped||busy)return;
  cancel(timer);
  if(!active()){timer=schedule(tick,delay);return;}
  busy=true;onBusy(true);
  try{const result=await check();if(!stopped){await onResult(result);if(result.status==='confirmed')stopped=true;}}
  catch(error){if(!stopped)onError(error);}
  finally{busy=false;if(!stopped){onBusy(false);timer=schedule(tick,delay);}}
 }
 timer=schedule(tick,0);
 return {refresh:tick,stop(){stopped=true;cancel(timer);}};
}
