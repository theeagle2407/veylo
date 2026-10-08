import fs from 'node:fs';
const u=new URL(process.argv[2]||'');
if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Provide the HTTPS backend origin only.');
fs.writeFileSync('vercel.json',JSON.stringify({version:2,buildCommand:null,outputDirectory:'vercel-public',rewrites:[{source:'/',destination:u.origin+'/'},{source:'/:path*',destination:`${u.origin}/:path*`}]},null,2)+'\n');
fs.mkdirSync('vercel-public',{recursive:true});fs.writeFileSync('vercel-public/.keep','');
console.log('Created Vercel proxy configuration. Backend must be online and use this website’s exact public origin.');
