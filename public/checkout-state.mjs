export function archiveCheckout(storage){
 const raw=storage.getItem('veylo.pending');if(!raw)return false;const pending=JSON.parse(raw);
 const list=JSON.parse(storage.getItem('veylo.cancelled')||'[]');
 const next=[...list.filter(p=>p.id!==pending.id),{...pending,cancelledAt:new Date().toISOString()}];
 storage.setItem('veylo.cancelled',JSON.stringify(next));storage.removeItem('veylo.pending');return true;
}
export function recoverCheckout(storage,id){
 if(storage.getItem('veylo.pending'))throw Error('Cancel or finish the active checkout first.');
 const list=JSON.parse(storage.getItem('veylo.cancelled')||'[]'),pending=list.find(p=>p.id===id);
 if(!pending)throw Error('Checkout not found.');
 storage.setItem('veylo.pending',JSON.stringify(pending));storage.setItem('veylo.cancelled',JSON.stringify(list.filter(p=>p.id!==id)));return pending;
}
