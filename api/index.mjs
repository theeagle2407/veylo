
import { randomUUID } from 'node:crypto';
import cloudHandler from '../cloud-runtime.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function createEntryHandler({ env = process.env, runtime = cloudHandler } = {}) {
  return async function handler(req, res) {
    const publicURL = new URL(
      env.VEYLO_PUBLIC_ORIGIN || 'https://veylo-steel.vercel.app'
    );

    const hosts = new Set([publicURL.host]);

    for (const value of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) {
      if (value && /^[A-Za-z0-9.-]+\.vercel\.app$/.test(value)) {
        hosts.add(value);
      }
    }

    if (!hosts.has(req.headers.host)) {
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      });
      return res.end(JSON.stringify({ error: 'Host not allowed.' }));
    }

    // Keep only Veylo session cookies.
    const cookies = String(req.headers.cookie || '')
      .split(';')
      .map(s => s.trim())
      .filter(s => /^veylo(?:_account)?=/.test(s));

    if (cookies.length) {
      req.headers.cookie = cookies.join('; ');
    } else {
      delete req.headers.cookie;
    }

    const url = new URL(req.url, publicURL);

    if (req.method === 'GET' && url.pathname === '/api/cloud/wallet-check') {
      const operation = url.searchParams.get('op');

      if (!operation) {
        res.writeHead(303, {
          Location: '/api/cloud/wallet-check?op=' + randomUUID(),
          'Cache-Control': 'no-store'
        });
        return res.end();
      }

      if (!UUID.test(operation)) {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store'
        });
        return res.end(JSON.stringify({
          error: 'Invalid check identifier.'
        }));
      }

      // Convert the read-only wallet diagnostic request to POST.
      // This does not authorize purchases, refunds, or other mutations.
      req.method = 'POST';
      req.body = {};
      req.url = '/api/cloud/wallet-check';
      req.headers.origin = 'https://' + req.headers.host;
      req.headers['content-type'] = 'application/json';
      req.headers['x-veylo-operation'] = operation;

      // Automatic two-second Refresh header intentionally removed.
      // Pending checks will no longer trigger automatic browser refreshes.
    }

    return runtime(req, res);
  };
}

export default createEntryHandler();
