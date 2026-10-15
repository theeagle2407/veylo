import {randomUUID} from 'node:crypto';
import cloudHandler from '../cloud-runtime.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function createEntryHandler({env = process.env, runtime = cloudHandler} = {}) {
  return async function handler(req, res) {
    const publicURL = new URL(env.VEYLO_PUBLIC_ORIGIN || 'https://veylo-steel.vercel.app');
    const hosts = new Set([publicURL.host]);
    for (const value of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) if (value && /^[A-Za-z0-9.-]+\.vercel\.app$/.test(value)) hosts.add(value);
    if (!hosts.has(req.headers.host)) {
      res.writeHead(403, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      return res.end(JSON.stringify({error: 'Host not allowed.'}));
    }
    // Vercel protection and toolbar cookies are unrelated to Veylo sessions.
    // Their rotation must not change an in-progress wallet operation's binding.
    const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => /^veylo(?:_account)?=/.test(s));
    if (cookies.length) req.headers.cookie = cookies.join('; ');
    else delete req.headers.cookie;
    const url = new URL(req.url, publicURL);
    if (req.method === 'GET' && url.pathname === '/api/cloud/wallet-check') {
      const operation = url.searchParams.get('op');
      if (!operation) {
        res.writeHead(303, {Location: '/api/cloud/wallet-check?op=' + randomUUID(), 'Cache-Control': 'no-store'});
        return res.end();
      }
      if (!UUID.test(operation)) {
        res.writeHead(400, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        return res.end(JSON.stringify({error: 'Invalid check identifier.'}));
      }
      // This adapter invokes only the authenticated, read-only wallet diagnostic.
      // It cannot turn a GET into a purchase, refund, or other product mutation.
      req.method = 'POST'; req.body = {}; req.url = '/api/cloud/wallet-check';
      req.headers.origin = 'https://' + req.headers.host;
      req.headers['content-type'] = 'application/json';
      req.headers['x-veylo-operation'] = operation;
      const end = res.end.bind(res);
      res.end = function (value, ...rest) {
        let data;
        try {data = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));} catch {}
        if (!res.headersSent && (res.statusCode === 202 && data?.pending || res.statusCode === 503 && data?.code === 'VEYLO_CLOUD_BUSY')) {
          res.setHeader('Refresh', '2; url=/api/cloud/wallet-check?op=' + operation);
        }
        return end(value, ...rest);
      };
    }
    return runtime(req, res);
  };
}

export default createEntryHandler();
