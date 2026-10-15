// Cloud-only transport. The existing product screens keep their normal API.
const UUID = () => crypto.randomUUID();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
const PUBLIC_READS = new Set(['/api/catalog', '/api/product', '/api/reviews', '/api/notices', '/api/cloud/health']);

export function createCloudFetch(original, {origin, pause = sleep, operationId = UUID, clock = () => Date.now(), onWait = () => {}, onWaitEnd = () => {}} = {}) {
  let walletTail = Promise.resolve();
  async function durable(input, init = {}) {
    const headers = new Headers(init.headers);
    const id = operationId();
    headers.set('X-Veylo-Operation', id);
    const options = {...init, headers};
    const started = clock();
    let networkErrors = 0, storageErrors = 0, waiting = false;
    try {
      while (clock() - started < 600000) {
        if (init.signal?.aborted) throw init.signal.reason || new DOMException('Request cancelled.', 'AbortError');
        let response;
        try {response = await original(input, options); networkErrors = 0;}
        catch (error) {
          if (init.signal?.aborted || ++networkErrors > 3) throw error;
          await pause(1000 * networkErrors); continue;
        }
        if (![202, 503].includes(response.status)) return response;
        let data;
        try {data = await response.clone().json();} catch {return response;}
        if (response.status === 503 && !['VEYLO_CLOUD_BUSY', 'VEYLO_CLOUD_RETRY', 'VEYLO_CLOUD_LEASE_LOST'].includes(data.code)) return response;
        if (response.status === 202 && !data.pending) return response;
        if (response.status === 503 && data.code !== 'VEYLO_CLOUD_BUSY' && ++storageErrors > 3) return response;
        if (response.status === 202) storageErrors = 0;
        waiting = true;
        const message = response.status === 202 ? data.message || 'The wallet operation is still running.'
          : data.code === 'VEYLO_CLOUD_BUSY' ? 'The store is handling another request. Retrying…'
          : 'The cloud connection was interrupted. Retrying…';
        onWait(message, id);
        await pause(Math.max(600, Math.min(4000, data.retryAfterMs || 1500)));
      }
      throw Error('The store is taking longer than expected. Check the current payment status before starting another payment.');
    } finally {if (waiting) onWaitEnd(id);}
  }
  async function checked(route, body) {
    const response = await durable(new URL(route, origin).href, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'Request failed.');
    return value;
  }
  async function request(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/connector/')) return original(input, init);
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'POST' && url.pathname === '/api/download') {
      const authorization = JSON.parse(init.body);
      const file = await checked('/api/cloud/download/start', authorization);
      const parts = [];
      for (let i = 0; i < Math.ceil(file.bytes / file.chunkBytes); i++) {
        const response = await durable(new URL('/api/cloud/download/chunk', origin).href, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token: file.token, index: i}), signal: init.signal});
        if (!response.ok) {const error = await response.json(); throw Error(error.error || 'Download unavailable.');}
        parts.push(new Uint8Array(await response.arrayBuffer()));
      }
      const bytes = new Uint8Array(file.bytes);
      let offset = 0;
      for (const part of parts) {if (offset + part.length > bytes.length) throw Error('Download size mismatch.'); bytes.set(part, offset); offset += part.length;}
      if (offset !== file.bytes || hex(await crypto.subtle.digest('SHA-256', bytes)) !== file.sha256) throw Error('The downloaded file failed its fingerprint check.');
      return new Response(bytes, {status: 200, headers: {'Content-Type': file.type, 'Content-Disposition': `attachment; filename="${file.name}"`}});
    }
    if (method === 'POST' && url.pathname === '/api/seller/products/publish') {
      const input = JSON.parse(init.body), {fileBase64, ...product} = input;
      const raw = atob(fileBase64), bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      const upload = await checked('/api/cloud/upload/start', {bytes: bytes.length, sha256: hex(await crypto.subtle.digest('SHA-256', bytes))});
      for (let offset = 0, index = 0; offset < bytes.length; offset += upload.chunkBytes, index++) {
        let text = '';
        const end = Math.min(bytes.length, offset + upload.chunkBytes);
        for (let i = offset; i < end; i += 8192) text += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 8192)));
        await checked('/api/cloud/upload/chunk', {id: upload.id, index, base64: btoa(text)});
      }
      const result = await checked('/api/cloud/upload/finish', {id: upload.id, product});
      return Response.json(result, {status: 201});
    }
    return durable(input, init);
  }
  return function cloudFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/connector/')) return original(input, init);
    if ((init.method || 'GET').toUpperCase() === 'GET' && PUBLIC_READS.has(url.pathname)) return request(input, init);
    // Only one state-changing/private operation from this tab runs at a time.
    // A complete upload/download owns one queue slot, including its subrequests.
    const pending = walletTail.then(() => request(input, init));
    walletTail = pending.then(() => {}, () => {});
    return pending;
  };
}

if (typeof window !== 'undefined' && !window.__veyloCloudTransport) {
  window.__veyloCloudTransport = true;
  const waiting = new Map();
  let lastMessage = '';
  function updateWait() {
    const toast = document.getElementById('toast');
    if (!toast) return;
    if (!waiting.size) {if (toast.textContent === lastMessage) toast.style.display = 'none'; return;}
    lastMessage = [...waiting.values()].at(-1);
    toast.textContent = lastMessage; toast.style.display = 'block';
  }
  window.fetch = createCloudFetch(window.fetch.bind(window), {origin: window.location.origin,
    onWait(message, id) {waiting.set(id, message); updateWait();},
    onWaitEnd(id) {waiting.delete(id); updateWait();},
  });
}
