import {hostingConfig} from './hosting.mjs';
import {productStats} from './product-stats.mjs';
import {MerchantCatalog,OWNER} from './merchant.mjs';
import {downloadFiles} from './downloads.mjs';
import {products,legacyProducts} from './catalog.mjs';
import {startRefundMonitor} from './monitor.mjs';
import {Wallet} from './wallet.mjs';
import {Payments,testProduct,shieldedTestAddress} from './payments.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Store,newState,product} from './core.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const dir=process.env.VEYLO_DATA_DIR||path.join(root,'data');fs.mkdirSync(dir,{recursive:true,mode:0o700});
const filename=path.join(dir,'state.json');
function save(s){fs.writeFileSync(filename+'.tmp',JSON.stringify(s),{mode:0o600});fs.renameSync(filename+'.tmp',filename);}
const store=new Store(fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):newState(),save);save(store.state);
const merchant=new MerchantCatalog(store,{root,assetDir:path.join(dir,'assets')});
store.productLookup=(id,archived=false)=>merchant.get(id,archived);
const live=process.env.VEYLO_PAYMENT_MODE==='testnet';
if(process.env.VEYLO_PAYMENT_MODE&&!['testnet','simulation'].includes(process.env.VEYLO_PAYMENT_MODE))throw Error('Invalid payment mode.');
const walletConfig={binary:process.env.VEYLO_WALLET_BINARY,directory:process.env.VEYLO_SELLER_WALLET,identity:process.env.VEYLO_SELLER_IDENTITY,account:process.env.VEYLO_SELLER_ACCOUNT};
if(live&&Object.values(walletConfig).some(v=>!v))throw Error('Missing testnet wallet settings. Run the setup script.');
const payments=live?new Payments(store,new Wallet(walletConfig)):null;
const code=process.env.VEYLO_SELLER_CODE||randomBytes(12).toString('hex'),sessions=new Map();
const {host,port,origin,allowedHosts,allowedOrigins,secureCookie}=hostingConfig(process.env);
if(host!=='127.0.0.1'&&!process.env.VEYLO_SELLER_CODE)throw Error('Public hosting requires VEYLO_SELLER_CODE.');
const equal=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function admin(req){const cookie=req.headers.cookie?.match(/(?:^|;\s*)veylo=([a-f0-9]+)/)?.[1];return cookie&&sessions.get(cookie)>Date.now();}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req,max=16384){let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>max)throw Error('Request too large.');}return data?JSON.parse(data):{};}
const files={'/':'index.html','/app.js':'app.js','/checkout-state.mjs':'checkout-state.mjs','/payment-watch.mjs':'payment-watch.mjs','/style.css':'style.css'};

const limits=new Map();
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 try{
  if(!allowedHosts.has(req.headers.host))return send(res,403,{error:'Host not allowed.'});
  const url=new URL(req.url,origin), route=url.pathname;
  if(req.method==='POST'){
   if(!allowedOrigins.has(req.headers.origin))return send(res,403,{error:'Same-origin request required.'});
   if(!req.headers['content-type']?.startsWith('application/json'))return send(res,415,{error:'JSON required.'});
   const now=Date.now(),key=req.socket.remoteAddress;let entry=limits.get(key);if(!entry||entry.until<now){entry={count:0,until:now+60000};limits.set(key,entry);}if(++entry.count>100)return send(res,429,{error:'Please wait a minute before trying again.'});
   if(route==='/api/seller/products/publish'&&!admin(req))return send(res,401,{error:'Seller sign-in required.'});
   const b=await body(req,route==='/api/seller/products/publish'?12*1024*1024:16384);
   if(route==='/api/seller/login'){
    if(!equal(b.code,code))return send(res,401,{error:'Seller access code is incorrect.'});
    const token=randomBytes(32).toString('hex');sessions.set(token,Date.now()+8*3600000);res.setHeader('Set-Cookie',`veylo=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie}`);return send(res,200,{ok:true});
   }
   if(route==='/api/seller/logout'){const t=req.headers.cookie?.match(/veylo=([a-f0-9]+)/)?.[1];sessions.delete(t);res.setHeader('Set-Cookie',`veylo=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);return send(res,200,{ok:true});}
   if(route.startsWith('/api/seller/')&&!admin(req))return send(res,401,{error:'Seller sign-in required.'});
   if(route==='/api/seller/profile')return send(res,200,merchant.profile(OWNER,b));
   if(route==='/api/seller/products/publish')return send(res,201,merchant.publish(OWNER,b));
   if(route==='/api/seller/products/status')return send(res,200,merchant.setStatus(OWNER,b.id,b.status));
   if(route==='/api/purchases')return send(res,201,live?await payments.create(b.key,b.productId):store.createPurchase(b.key,b.productId));
   if(route==='/api/check-payment'){if(!live)throw Error('Testnet mode is not enabled.');return send(res,200,await payments.check(b.id,b.token));}
   if(route==='/api/seller/check-refunds'){if(!live)throw Error('Testnet mode is not enabled.');return send(res,200,await payments.refresh());}
   if(route==='/api/seller/send-refund'){if(!live)throw Error('Testnet mode is not enabled.');return send(res,200,await payments.refund(b.id));}
   if(route==='/api/simulate-payment')return send(res,200,store.simulatePayment(b.id));
   if(route==='/api/challenges')return send(res,200,store.issueChallenge(b.id));
   if(route==='/api/reviews')return send(res,200,store.writeReview(b.request,b.signature));
   if(route==='/api/download'){
    const id=store.authorizeDownload(b.request,b.signature);
    const delivery=store.state.purchases[b.request.purchaseId]?.receipt?.delivery;
    if(delivery){const file=merchant.readDelivery(delivery);res.writeHead(200,{'Content-Type':file.type,'Content-Disposition':`attachment; filename="${file.name}"`,'Cache-Control':'no-store'});return res.end(file.bytes);}
    const name=downloadFiles[id];if(!name)throw Error('Download unavailable.');
    const data=fs.readFileSync(path.join(root,'private-products',name));
    res.writeHead(200,{'Content-Type':name.endsWith('.zip')?'application/zip':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'no-store'});return res.end(data);
   }
   if(route==='/api/purchase-status')return send(res,200,store.purchaseStatus(b.request,b.signature));
   if(route==='/api/refunds/withdraw')return send(res,200,store.withdrawRefund(b.request,b.signature));
   if(route==='/api/refunds'){if(store.state.purchases[b.request?.purchaseId]?.receipt?.paymentMode==='testnet'&&!shieldedTestAddress(b.request?.destination))throw Error('Enter a shielded testnet receiving address.');return send(res,201,store.requestRefund(b.request,b.signature));}
   if(route==='/api/seller/decline-refund')return send(res,200,store.declineRefund(b.id,b.reason));
   if(route==='/api/seller/notices')return send(res,201,store.publishNotice(b));
   if(route==='/api/seller/simulate-refund')return send(res,200,store.simulateRefund(b.id));
  }
  if(req.method==='GET'){
   if(route==='/api/product'){const p=merchant.get(url.searchParams.get('id'),true);return send(res,200,{product:{...merchant.publicItem(p),asset:live?'TAZ':'ZEC'},store:merchant.data().profile,stats:productStats(store,p.id,live?'testnet':'simulation'),refundOffered:store.state.notices.some(n=>n.product===p.id&&n.version===p.version&&n.refundAvailable)});}
   if(route==='/api/catalog')return send(res,200,{product:live?testProduct:product,products:merchant.list().map(p=>({...p,asset:live?'TAZ':'ZEC'})),legacyProducts:merchant.archived().map(p=>({...p,asset:live?'TAZ':'ZEC'})),store:merchant.data().profile,merchantKey:store.state.publicKey,paymentMode:live?'testnet':'simulation'});
   if(route==='/api/reviews')return send(res,200,store.publicReviews());
   if(route==='/api/notices')return send(res,200,store.state.notices);
   if(route==='/api/seller/products'){if(!admin(req))return send(res,401,{error:'Seller sign-in required.'});return send(res,200,merchant.dashboard(OWNER));}
   if(route==='/api/seller'){if(!admin(req))return send(res,401,{error:'Seller sign-in required.'});return send(res,200,{requests:Object.values(store.state.requests).map(q=>({...q,productId:store.state.purchases[q.purchaseId]?.receipt?.product,paymentMode:store.state.purchases[q.purchaseId]?.receipt?.paymentMode,asset:store.state.purchases[q.purchaseId]?.receipt?.asset})),notices:store.state.notices,purchases:Object.values(store.state.purchases).filter(p=>p.receipt).length});}
   if(files[route]){const ext=path.extname(files[route]);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.txt':'text/plain; charset=utf-8'})[ext],'Cache-Control':'no-store'});return res.end(fs.readFileSync(path.join(root,'public',files[route])));}
  }
  send(res,404,{error:'Not found.'});
 }catch(error){send(res,400,{error:error.message||'Request failed.'});}
});
server.once('listening',()=>{if(payments){const stop=startRefundMonitor(payments,{onError:()=>console.error('Refund check unavailable; retrying automatically.')});server.once('close',stop);}});
server.listen(port,host,()=>{console.log(`\nVeylo: http://localhost:${port}\nSeller access code: ${host==='127.0.0.1'?code:'configured privately'}\n\n${live?'Zcash testnet payments enabled. Seller approves real testnet refunds.':'Local payment simulation. No ZEC is sent.'}\nKeep data/state.json private: it contains the merchant signing key.\n`);});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Port ${port} is in use. Stop the previous server or run PORT=3003 npm run dev.`:e.message);process.exitCode=1;});
