import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {products,legacyProducts} from './catalog.mjs';
import {downloadFiles} from './downloads.mjs';
export const MAX_FILE=8*1024*1024;
export const OWNER='primary';
const digest=b=>createHash('sha256').update(b).digest('hex');
function text(v,label,max,min=1){if(typeof v!=='string'||v.trim().length<min||v.trim().length>max||/[\u0000-\u0008\u000b-\u001f]/.test(v))throw Error(`${label} must contain ${min}–${max} characters.`);return v.trim();}
function amount(v){if(typeof v!=='string'||!/^\d{1,7}(?:\.\d{1,8})?$/.test(v))throw Error('Enter a positive price with at most 8 decimal places.');const [a,b='']=v.split('.'),n=BigInt(a)*100000000n+BigInt(b.padEnd(8,'0'));if(n<1n||n>100000000000000n)throw Error('Price is outside the supported range.');return {value:Number(n),price:`${n/100000000n}.${String(n%100000000n).padStart(8,'0')}`.replace(/0+$/,'').replace(/\.$/,'')};}
function filename(v){if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}\.(zip|pdf|txt|png|jpg|jpeg|wav)$/i.test(v))throw Error('Use a short filename ending in .zip, .pdf, .txt, .png, .jpg or .wav.');return v;}
const mime=n=>({zip:'application/zip',pdf:'application/pdf',txt:'text/plain; charset=utf-8',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',wav:'audio/wav'})[n.split('.').pop().toLowerCase()]||'application/octet-stream';
export class MerchantCatalog{
 constructor(store,{root,assetDir}){
  this.store=store;this.root=root;this.assetDir=assetDir;fs.mkdirSync(assetDir,{recursive:true,mode:0o700});
  if(!store.state.merchantCatalog){
   const items={};for(const p of [...products,...legacyProducts]){
    const f=downloadFiles[p.id],full=f&&path.join(root,'private-products',f);let delivery;
    if(full&&fs.existsSync(full))delivery=this.putAsset(f,fs.readFileSync(full));
    items[p.id]={...p,sellerId:OWNER,status:products.some(x=>x.id===p.id)?'published':'archived',...(delivery?{delivery}: {})};
   }
   this.commit({schema:1,profile:{id:OWNER,name:'Veylo Studio',bio:'Independent digital products.'},items});
  }
 }
 own(actor){if(actor!==OWNER)throw Error('Seller authorization required.');}
 commit(next){const previous=this.store.state.merchantCatalog;this.store.state.merchantCatalog=next;try{this.store.persist();}catch(e){this.store.state.merchantCatalog=previous;throw e;}}
 data(){return this.store.state.merchantCatalog;}
 publicItem(p){const {delivery,...item}=p;return {...item,seller:this.data().profile.name,...(delivery?{fileName:delivery.name,fileSize:delivery.bytes,fileHash:delivery.sha256}: {})};}
 list(){return Object.values(this.data().items).filter(p=>p.status==='published').map(p=>this.publicItem(p));}
 archived(){return Object.values(this.data().items).filter(p=>p.status!=='published').map(p=>this.publicItem(p));}
 dashboard(actor){this.own(actor);return {profile:{...this.data().profile},products:Object.values(this.data().items).map(p=>this.publicItem(p))};}
 get(id='fieldnotes',includeArchived=false){const p=this.data().items[id];if(!p||(!includeArchived&&p.status!=='published'))throw Error('This product is not available for new purchases.');return structuredClone({...p,seller:this.data().profile.name});}
 profile(actor,input){this.own(actor);const next=structuredClone(this.data());next.profile={id:OWNER,name:text(input.name,'Store name',60),bio:text(input.bio,'Store description',500)};this.commit(next);return {...next.profile};}
 putAsset(name,bytes){name=filename(name);if(!bytes.length||bytes.length>MAX_FILE)throw Error('Upload a non-empty file of up to 8 MiB.');const sha256=digest(bytes),target=path.join(this.assetDir,sha256);try{fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;if(digest(fs.readFileSync(target))!==sha256)throw Error('Stored file integrity check failed.');}return {schema:'veylo.delivery.v1',sha256,bytes:bytes.length,name};}
 publish(actor,input){
  this.own(actor);const name=text(input.name,'Product name',80),description=text(input.description,'Product description',1000,20),category=text(input.category,'Category',30),version=text(input.version,'Version',24),pricing=amount(input.price);
  if(!['Software','Design','Audio','Writing','Templates','Other'].includes(category))throw Error('Choose a supported category.');
  if(typeof input.fileBase64!=='string'||input.fileBase64.length>Math.ceil(MAX_FILE/3)*4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.fileBase64))throw Error('Invalid file encoding.');
  const delivery=this.putAsset(input.fileName,Buffer.from(input.fileBase64,'base64'));
  const p={id:'product-'+randomUUID(),sellerId:OWNER,name,description,category,version,...pricing,asset:'ZEC',kind:'Digital download',seller:this.data().profile.name,tone:({Software:'blue',Design:'purple',Audio:'green',Writing:'terra',Templates:'gold',Other:'rose'})[category],mark:name.replace(/[^a-z0-9]/gi,'').slice(0,2).toUpperCase()||'V',format:delivery.name.split('.').pop().toUpperCase()+' download',download:'/api/download',delivery,status:'published'};
  const next=structuredClone(this.data());next.items[p.id]=p;this.commit(next);return this.publicItem(p);
 }
 setStatus(actor,id,status){this.own(actor);if(!['published','archived'].includes(status))throw Error('Invalid product status.');const next=structuredClone(this.data()),p=next.items[id];if(!p||p.sellerId!==actor)throw Error('Product not found.');if(status==='published'&&!p.delivery)throw Error('A downloadable file is required.');p.status=status;this.commit(next);return this.publicItem(p);}
 readDelivery(d){if(d?.schema!=='veylo.delivery.v1'||!/^[a-f0-9]{64}$/.test(d.sha256)||!Number.isSafeInteger(d.bytes))throw Error('Invalid delivery record.');filename(d.name);const bytes=fs.readFileSync(path.join(this.assetDir,d.sha256));if(bytes.length!==d.bytes||digest(bytes)!==d.sha256)throw Error('Download integrity check failed. Ask the seller to restore the original file.');return {bytes,name:d.name,type:mime(d.name)};}
}
