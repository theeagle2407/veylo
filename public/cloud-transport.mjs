// Cloud-only transport. The existing product screens keep their normal API.
const UUID = () => crypto.randomUUID();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');

export function createCloudFetch(original, {origin, pause = sleep, operationId = UUID, clock = () => Date.now(), onWait = () => {}} = {}) {
  async function durable(input, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('X-Veylo-Operation', operationId());
    const options = {...init, headers};
    const started = clock();
    let networkErrors = 0, storageErrors = 0;
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
      onWait(data.message || 'The store is finishing a wallet update. Your progress is saved.');
      await pause(Math.max(600, Math.min(4000, data.retryAfterMs || 1500)));
    }
    throw Error('The wallet is taking longer than expected. Your progress is saved. Check status before starting another payment.');
  }
  async function checked(route, body) {
    const response = await durable(new URL(route, origin).href, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'Request failed.');
    return value;
  }
  return async function cloudFetch(input, init = {}) {
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
  };
}

if (typeof window !== 'undefined' && !window.__veyloCloudTransport) {
  window.__veyloCloudTransport = true;
  window.fetch = createCloudFetch(window.fetch.bind(window), {origin: window.location.origin, onWait: message => {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message; toast.style.display = 'block';
    clearTimeout(window.__veyloCloudWaitTimer);
    window.__veyloCloudWaitTimer = setTimeout(() => {if (toast.textContent === message) toast.style.display = 'none';}, 4500);
  }});
}
