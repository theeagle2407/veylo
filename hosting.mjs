export function hostingConfig(env={}) {
 const port=Number(env.PORT||3002);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid PORT.');
 const host=env.VEYLO_BIND_HOST||'127.0.0.1';
 const local=host==='127.0.0.1';
 const parse=value=>{
  const u=new URL(value);
  if(u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Use an origin without a path or credentials.');
  if(!local&&u.protocol!=='https:')throw Error('Public origins require HTTPS.');
  if(!['https:','http:'].includes(u.protocol))throw Error('Invalid origin protocol.');
  return u;
 };
 if(!local&&!env.VEYLO_PUBLIC_ORIGIN)throw Error('Set VEYLO_PUBLIC_ORIGIN for public hosting.');
 const publicURL=parse(env.VEYLO_PUBLIC_ORIGIN||`http://127.0.0.1:${port}`);
 const allowedOrigins=new Set([publicURL.origin]);
 const allowedHosts=new Set([publicURL.host]);
 if(local){allowedOrigins.add(`http://localhost:${port}`);allowedHosts.add(`localhost:${port}`);allowedHosts.add(`127.0.0.1:${port}`);}
 if(env.VEYLO_BACKEND_ORIGIN)allowedHosts.add(parse(env.VEYLO_BACKEND_ORIGIN).host);
 return {host,port,origin:publicURL.origin,allowedOrigins,allowedHosts,secureCookie:publicURL.protocol==='https:'?'; Secure':''};
}
