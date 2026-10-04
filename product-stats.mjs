// Aggregate only. Never expose purchase keys, IDs, addresses or transaction records.
export function productStats(store,productId,mode){
 if(!['simulation','testnet'].includes(mode))throw Error('Invalid payment mode.');
 let purchases=0,refunded=0;const eligible=new Set();
 const completed=new Set(Object.values(store.state.requests).filter(q=>q.status===(mode==='testnet'?'confirmed':'simulated')).map(q=>q.purchaseId));
 for(const p of Object.values(store.state.purchases)){
  const r=p.receipt;if(!r||r.product!==productId||r.paymentMode!==mode||!store.validateReceipt(r))continue;
  purchases++;eligible.add(p.id);if(completed.has(p.id))refunded++;
 }
 const reviews=Object.entries(store.state.reviews||{}).filter(([id,r])=>eligible.has(id)&&r.product===productId&&r.paymentMode===mode&&Number.isInteger(r.rating)&&r.rating>=1&&r.rating<=5).map(([,r])=>({id:r.id,rating:r.rating,text:r.text,updatedAt:r.updatedAt})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 return {paymentMode:mode,purchases,refunded,reviewCount:reviews.length,averageRating:reviews.length?Math.round(reviews.reduce((n,r)=>n+r.rating,0)/reviews.length*10)/10:null,reviews};
}
