import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, createHmac, randomBytes, randomUUID} from 'node:crypto';
import {createVeyloApp} from './server.mjs';
import {CloudVault, cloudClient} from './cloud-state.mjs';
import {Wallet} from './wallet.mjs';
import {ConnectorJobs, RemoteWallet} from './connector-jobs.mjs';
import {MAX_FILE, OWNER} from './merchant.mjs';
import {downloadFiles} from './downloads.mjs';

const execute = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
export const TRANSFER_BYTES = 512 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TX = /^[a-f0-9]{64}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const pendingStates = ['sending', 'unknown', 'broadcast'];
const PUBLIC_READS = new Set(['/api/catalog', '/api/product', '/api/reviews', '/api/notices', '/api/cloud/health']);
const safeName = name => typeof name === 'string' && /^[A-Za-z0-9._/-]{1,240}$/.test(name) &&
  !name.startsWith('/') && !name.split('/').some(p => !p || p === '.' || p === '..') &&
  (name.startsWith('data/') || name.startsWith('wallet/') || ['config.json', 'runtime.json', 'identity.txt'].includes(name));

export class CloudPending extends Error {
  constructor(message = 'The wallet operation is still running.') {super(message); this.code = 'VEYLO_CLOUD_PENDING';}
}
function problem(code, message) {return Object.assign(new Error(message), {code});}
function json(res, status, value, headers = {}) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers});
  res.end(JSON.stringify(value));
}
function security(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}
function bufferResponse() {
  const headers = new Map();
  return {statusCode: 200, headers, payload: Buffer.alloc(0), ended: false,
    setHeader(name, value) {headers.set(name.toLowerCase(), value); return this;},
    getHeader(name) {return headers.get(name.toLowerCase());},
    writeHead(status, values = {}) {this.statusCode = status; for (const [k, v] of Object.entries(values)) this.setHeader(k, v); return this;},
    end(value = '') {this.payload = Buffer.isBuffer(value) ? value : Buffer.from(value); this.ended = true;},
  };
}
function writeResponse(res, buffered) {
  for (const [k, v] of buffered.headers) res.setHeader(k, v);
  res.statusCode = buffered.statusCode;
  res.end(buffered.payload);
}

function cloudSettings(files, allowSimulation) {
  if (!files.has('data/state.json') || !files.has('config.json')) throw problem('VEYLO_CLOUD_NOT_IMPORTED', 'Application data has not been imported into this deployment environment.');
  const config = JSON.parse(files.get('config.json').toString('utf8'));
  if (config.schema !== 1 || !UUID.test(config.account || '') || typeof config.sellerCode !== 'string' || config.sellerCode.length < 12 || config.paymentMode !== 'testnet' && !(allowSimulation && config.paymentMode === 'simulation')) throw Error('The imported cloud settings are invalid.');
  return config;
}

// Public pages need committed application data, never the wallet database or a
// writer lease. Authenticate one captured revision and only its selected files.
export async function readPublicCloudFiles(vault) {
  const integrity = () => problem('VEYLO_CLOUD_INTEGRITY', 'Stored application data could not be authenticated.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await vault.client.execute({sql: 'SELECT revision, manifest FROM veylo_cloud_root_v1 WHERE scope = ?', args: [vault.scope]});
    if (result.rows.length !== 1) throw problem('VEYLO_CLOUD_NOT_IMPORTED', 'Application data has not been imported into this deployment environment.');
    const row = result.rows[0], revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw integrity();
    const manifest = vault.decodeManifest(row.manifest, revision);
    const selected = ['config.json', 'data/state.json'].map(name => manifest?.files.find(file => file.name === name));
    if (selected.some(file => !file)) throw problem('VEYLO_CLOUD_NOT_IMPORTED', 'Application data has not been imported into this deployment environment.');
    if (selected.reduce((sum, file) => sum + file.bytes, 0) > 16 * 1048576) throw problem('VEYLO_CLOUD_INVALID', 'Application metadata exceeds the supported read size.');
    const ids = [...new Set(selected.flatMap(file => file.chunks))], chunks = new Map();
    let missing = false;
    for (let offset = 0; offset < ids.length; offset += 2) {
      const group = ids.slice(offset, offset + 2);
      const rows = await vault.client.execute({sql: `SELECT id, payload, plain_bytes FROM veylo_cloud_chunks_v1 WHERE scope = ? AND id IN (${group.map(() => '?').join(',')})`, args: [vault.scope, ...group]});
      if (rows.rows.length !== group.length) {missing = true; break;}
      for (const item of rows.rows) {
        if (!group.includes(item.id) || chunks.has(item.id)) throw integrity();
        const bytes = vault.open(item.payload, 'chunk:' + item.id);
        if (bytes.length !== Number(item.plain_bytes) || bytes.length > 65536 || vault.tag(bytes) !== item.id) throw integrity();
        chunks.set(item.id, bytes);
      }
    }
    if (missing) {
      // A concurrent writer may commit and collect an older revision while we
      // read it. Restart only when that revision really changed; fail closed if
      // the current committed snapshot itself has missing or damaged chunks.
      const current = await vault.client.execute({sql: 'SELECT revision FROM veylo_cloud_root_v1 WHERE scope = ?', args: [vault.scope]});
      if (current.rows.length === 1 && Number(current.rows[0].revision) > revision) continue;
      throw integrity();
    }
    const files = new Map();
    for (const file of selected) {
      const bytes = Buffer.concat(file.chunks.map(id => chunks.get(id)));
      if (bytes.length !== file.bytes || vault.tag(bytes) !== file.digest) throw integrity();
      files.set(file.name, bytes);
    }
    return files;
  }
  throw problem('VEYLO_CLOUD_RETRY', 'Application data changed during the read. Retry shortly.');
}

export function restoreCloudFiles(directory, files) {
  for (const [name, bytes] of files) {
    if (!safeName(name)) throw problem('VEYLO_CLOUD_INVALID', 'The stored snapshot contains an unexpected path.');
    const dest = path.join(directory, name);
    fs.mkdirSync(path.dirname(dest), {recursive: true, mode: 0o700});
    fs.writeFileSync(dest, bytes, {mode: 0o600});
  }
}
export function captureCloudFiles(directory) {
  const result = new Map();
  let total = 0;
  function walk(relative) {
    const full = path.join(directory, relative);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw Error('Snapshot paths must not contain symbolic links.');
    if (stat.isDirectory()) {for (const name of fs.readdirSync(full)) walk(path.posix.join(relative, name)); return;}
    if (!stat.isFile() || !safeName(relative)) throw Error('An unsupported snapshot file was found.');
    if (relative.endsWith('-shm') || relative.endsWith('.tmp')) return;
    const bytes = fs.readFileSync(full);
    total += bytes.length;
    if (total > 256 * 1048576 || result.size >= 4096) throw Error('The cloud snapshot exceeds the supported size.');
    result.set(relative, bytes);
  }
  for (const name of ['data', 'wallet', 'config.json', 'runtime.json', 'identity.txt']) if (fs.existsSync(path.join(directory, name))) walk(name);
  return result;
}

function metadata(files) {
  if (!files.has('runtime.json')) return {schema: 1, sessions: [], accountSessions: [], limits: [], operations: {}, uploads: {}, downloads: {}};
  const value = JSON.parse(files.get('runtime.json').toString('utf8'));
  if (value.schema !== 1 || !Array.isArray(value.sessions) || !Array.isArray(value.accountSessions) || !Array.isArray(value.limits) ||
      !value.operations || !value.uploads || !value.downloads) throw Error('The saved cloud runtime state is invalid.');
  return value;
}
function prune(meta, directory, now) {
  meta.sessions = meta.sessions.filter(([, until]) => until > now);
  meta.accountSessions = meta.accountSessions.filter(([, value]) => value.until > now);
  meta.limits = meta.limits.filter(([, value]) => value.until > now);
  for (const [id, entry] of Object.entries(meta.operations)) if (entry.expiresAt <= now) delete meta.operations[id];
  const done = Object.entries(meta.operations).filter(([, entry]) => entry.completedAt || entry.response).sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (Object.keys(meta.operations).length > 500 && done.length) delete meta.operations[done.shift()[0]];
  for (const [id, entry] of Object.entries(meta.uploads)) if (entry.expiresAt <= now) {
    fs.rmSync(path.join(directory, 'data', 'cloud-uploads', id), {recursive: true, force: true});
    delete meta.uploads[id];
  }
  for (const [id, entry] of Object.entries(meta.downloads)) if (entry.expiresAt <= now) delete meta.downloads[id];
}
function statusView(store, id) {
  const p = store.state.purchases[id];
  const requests = Object.values(store.state.requests).filter(q => q.purchaseId === id);
  const q = requests.find(q => q.status !== 'withdrawn') || requests.at(-1);
  const fields = ['decisionReason', 'decidedAt', 'id', 'withdrawnAt', 'status', 'reason', 'destination', 'attemptedAt', 'createdAt', 'completedAt', 'amount', 'txid', 'confirmations'];
  return {review: store.state.reviews?.[id] || null, downloadAllowed: store.downloadAllowed(id), refund: q ? {...Object.fromEntries(fields.map(k => [k, q[k]])), asset: p.receipt.asset} : null};
}

// No request waits for another HTTP request while owning the storage lease.
class DurableConnectorJobs extends ConnectorJobs {
  constructor(store, accounts, context) {super(store, accounts); this.context = context;}
  enqueue(actor, kind, input) {
    const account = this.accounts.data()[actor];
    if (!account?.connector || account.connector.expiresAt <= Date.now() || Date.now() - account.connector.lastSeen > 90000 || account.connector.report?.protocol !== 2) throw Error('Seller payment connector is offline.');
    const jobs = this.store.state.connectorJobs;
    for (const [id, job] of Object.entries(jobs)) if (job.kind !== 'send' && Date.now() - job.createdAt > 1800000) delete jobs[id];
    if (Object.values(jobs).filter(j => j.actor === actor && j.status === 'queued').length >= 20) throw Error('Seller connector is busy. Please retry shortly.');
    const job = {id: randomUUID(), actor, kind, input, account: account.walletAccount, status: 'queued', createdAt: Date.now(), credentialHash: account.connector.hash};
    jobs[job.id] = job;
    this.store.persist();
    return job;
  }
  async request(actor, kind, input) {
    const op = this.context.operation;
    if (!op) throw Error('Reload the page to continue this wallet operation.');
    const key = 'connector:' + sha(JSON.stringify([actor, kind, input]));
    let slot = op.steps[key];
    if (!slot) {
      const job = this.enqueue(actor, kind, input);
      slot = op.steps[key] = {jobId: job.id};
      await this.context.checkpoint();
    }
    const job = this.store.state.connectorJobs[slot.jobId];
    if (!job || job.actor !== actor || job.credentialHash !== this.accounts.data()[actor]?.connector?.hash) throw Error('The seller wallet connection changed. Start a new status check.');
    if (job.status !== 'done') throw new CloudPending();
    if (job.result?.error) throw Error('Seller wallet operation did not complete. Check the local connector.');
    return job.result?.value;
  }
  complete(token, id, result) {
    const reply = super.complete(token, id, result);
    const job = this.store.state.connectorJobs[id];
    if (!job.refundId) return reply;
    const q = this.store.state.requests[job.refundId], purchase = this.store.state.purchases[q?.purchaseId];
    if (!q || (purchase?.item?.sellerId || OWNER) !== job.actor || q.connectorJob !== job.id ||
        q.memo !== job.input.memo || q.destination !== job.input.address || q.value !== job.input.value) throw Error('Refund instruction does not match its recorded job.');
    if (!['sending', 'unknown'].includes(q.status)) return reply;
    if (typeof job.result?.value === 'string' && TX.test(job.result.value) && !job.result.error) {
      q.txid = job.result.value; q.status = 'broadcast';
    } else q.status = 'unknown';
    this.store.persist();
    return reply;
  }
}
class DurableRemoteWallet extends RemoteWallet {
  constructor(actor, jobs, context) {super(actor, jobs); this.context = context;}
  async deferRefund(q) {
    this.context.requireSpending();
    const job = this.jobs.enqueue(this.actor, 'send', {address: q.destination, value: q.value, memo: q.memo});
    job.refundId = q.id;
    q.connectorJob = job.id;
    this.jobs.store.persist();
    await this.context.checkpoint();
    return q;
  }
}

class DurableWallet extends Wallet {
  constructor(config, context) {super(config); this.context = context;}
  async command(args) {
    const c = this.context;
    await c.vault.assertActive(c.lease);
    const remaining = c.deadline - Date.now();
    if (remaining < 10000) throw Error('The wallet update needs another status check.');
    try {
      return await c.execute(this.config.binary, ['wallet', '-w', this.config.directory, ...args], {
        timeout: Math.min(180000, remaining - 8000), maxBuffer: 16 * 1048576,
        signal: c.abort.signal, env: {PATH: process.env.PATH || '/usr/bin:/bin', NO_COLOR: '1'},
      });
    } catch {
      throw Error(args[0] === 'send' ? 'Wallet send outcome needs reconciliation. No automatic retry.' : 'The testnet wallet update did not finish. Retry the status check.');
    } finally {
      // Every completed or terminated CLI command has a durable recovery point.
      // No success response is emitted if this upload fails.
      await c.checkpoint();
    }
  }
  async run(args) {
    if (args[0] === 'generate-address') return this.context.step('primary:address', () => this.command(args));
    if (args[0] !== 'send') return this.command(args);
    const c = this.context;
    c.requireSpending();
    const q = c.app.store.state.requests[c.operation?.refundId];
    if (!q || q.status !== 'sending' || q.memo !== args[args.indexOf('--memo') + 1] || q.destination !== args[args.indexOf('--address') + 1] || q.value !== Number(args[args.indexOf('--value') + 1])) throw Error('Missing durable refund intent.');
    if (c.operation.sendStarted) throw Error('A previous send may have occurred. Check confirmations; do not send again.');
    if (Object.values(c.app.store.state.requests).some(other => other.id !== q.id && ['sending', 'unknown'].includes(other.status) &&
        (c.app.store.state.purchases[other.purchaseId]?.item?.sellerId || OWNER) === OWNER && !other.txid)) throw Error('An earlier refund needs wallet reconciliation before another can be sent.');
    c.operation.sendStarted = true;
    await c.checkpoint();
    try {
      const value = await this.command(args);
      const ids = value.stdout.split(/\r?\n/).map(s => s.trim()).filter(s => TX.test(s));
      if (ids.length !== 1) {q.status = 'unknown'; throw Error('No unambiguous transaction ID was returned.');}
      q.txid = ids[0]; q.status = 'broadcast'; c.operation.refundTxid = ids[0];
      c.app.store.persist();
      await c.checkpoint();
      return value;
    } catch (error) {q.status = 'unknown'; c.app.store.persist(); await c.checkpoint(); throw error;}
  }
  async snapshot({fresh = false} = {}) {
    return this.context.step('primary:snapshot', async () => {
      const cache = this.context.meta.walletSnapshot;
      if (!fresh && cache && Date.now() >= cache.finishedAt && Date.now() - cache.finishedAt < 10000) return cache.value;
      const value = await super.snapshot({fresh: true});
      this.context.meta.walletSnapshot = {value, finishedAt: Date.now()};
      return value;
    });
  }
}

async function cloudRoutes(c, {route, req, res, body, store, merchant, sellerActor, sellerPayments, publishing, requireOwnRequest}) {
  const b = body;
  if (route === '/api/download' && req.method === 'POST') {
    json(res, 400, {error: 'Reload Veylo to use protected file delivery.'}); return true;
  }
  if (route === '/api/cloud/health' && req.method === 'GET') {
    json(res, 200, {ok: true, storage: 'encrypted', network: 'Zcash testnet', mode: c.live ? 'live' : 'scan-only', stateImported: true});
    return true;
  }
  if (route === '/api/cloud/wallet-check' && req.method === 'POST') {
    if (sellerActor(req) !== OWNER) {json(res, 401, {error: 'Primary seller sign-in required.'}); return true;}
    const wallet = c.app.payments.wallet;
    const network = await c.step('primary:network-check', () => wallet.command(['get-info', '--server', 'zecrocks']));
    const info = JSON.parse(network.stdout);
    if (info.chain_name !== 'test' || !Number.isSafeInteger(info.chain_tip_height) || !network.stderr.includes('WALLET_BRANCH: Nu7 (77190ad9)') || !/SERVER_BRANCH: (?:0x)?77190ad9/i.test(network.stderr)) throw Error('Wallet and testnet consensus branches do not agree.');
    const snapshot = await wallet.snapshot({fresh: true});
    json(res, 200, {ok: true, checkedAt: new Date().toISOString(), chainHeight: snapshot.height,
      walletTransactions: snapshot.transactions.length, cloudRecoveryVerified: true, transactionsSent: 0,
      scope: 'Actual wallet sync, enhancement and transaction reads. No new payment was sent.'});
    return true;
  }
  if (route === '/api/purchase-status' && req.method === 'POST') {
    const key = 'authorized-status';
    if (!c.operation.values[key]) {
      store.purchaseStatus(b.request, b.signature);
      c.operation.values[key] = b.request.purchaseId;
      await c.checkpoint();
    }
    const id = c.operation.values[key], purchase = store.state.purchases[id];
    if (Object.values(store.state.requests).some(q => q.purchaseId === id && pendingStates.includes(q.status))) await sellerPayments(purchase.item?.sellerId || OWNER).refresh();
    json(res, 200, statusView(store, id));
    return true;
  }
  if (route === '/api/seller' && req.method === 'GET') {
    const actor = sellerActor(req);
    if (actor && Object.values(store.state.requests).some(q => (store.state.purchases[q.purchaseId]?.item?.sellerId || OWNER) === actor && pendingStates.includes(q.status))) await sellerPayments(actor).refresh();
    return false;
  }
  if (route === '/api/seller/send-refund' && req.method === 'POST') {
    const actor = sellerActor(req);
    if (!actor) {json(res, 401, {error: 'Seller sign-in required.'}); return true;}
    c.requireSpending();
    requireOwnRequest(actor, b.id);
    if (actor === OWNER && !fs.existsSync(path.join(c.directory, 'identity.txt'))) throw Error('The cloud seller identity has not been imported. No refund was sent.');
    c.operation.refundId ??= b.id;
    const q = store.state.requests[b.id];
    if (c.operation.refundAttempted && q.status !== 'requested') {
      if (q.connectorJob && ['queued', 'started'].includes(store.state.connectorJobs[q.connectorJob]?.status)) throw new CloudPending('Awaiting the seller’s terminal approval.');
      if (['broadcast', 'confirmed'].includes(q.status) && q.txid) {json(res, 200, q); return true;}
      throw Error('Refund outcome needs checking. No automatic retry will occur. Use Check confirmations.');
    }
    return false;
  }

  if (!route.startsWith('/api/cloud/')) return false;
  if (req.method !== 'POST') return false;
  if (route.startsWith('/api/cloud/upload/')) {
    const actor = sellerActor(req);
    if (!actor) {json(res, 401, {error: 'Seller sign-in required.'}); return true;}
    publishing(actor);
    if (route === '/api/cloud/upload/start') {
      if (!Number.isSafeInteger(b.bytes) || b.bytes < 1 || b.bytes > MAX_FILE || !TX.test(b.sha256 || '')) throw Error('Choose a non-empty file of up to 8 MiB.');
      if (Object.values(c.meta.uploads).filter(u => u.actor === actor).length >= 3) throw Error('Finish the current upload before starting another.');
      const id = randomUUID(); c.meta.uploads[id] = {actor, bytes: b.bytes, sha256: b.sha256, expiresAt: Date.now() + 900000};
      json(res, 201, {id, chunkBytes: TRANSFER_BYTES}); return true;
    }
    if (!UUID.test(b.id || '')) throw Error('Upload not found.');
    const upload = c.meta.uploads[b.id];
    if (!upload || upload.actor !== actor || upload.expiresAt <= Date.now()) throw Error('Upload expired. Select the file again.');
    const folder = path.join(c.directory, 'data', 'cloud-uploads', b.id);
    if (route === '/api/cloud/upload/chunk') {
      const count = Math.ceil(upload.bytes / TRANSFER_BYTES);
      if (!Number.isInteger(b.index) || b.index < 0 || b.index >= count || typeof b.base64 !== 'string' || b.base64.length > Math.ceil(TRANSFER_BYTES / 3) * 4 || b.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.base64)) throw Error('Invalid upload chunk.');
      const bytes = Buffer.from(b.base64, 'base64'), expected = Math.min(TRANSFER_BYTES, upload.bytes - b.index * TRANSFER_BYTES);
      if (bytes.length !== expected) throw Error('Incomplete upload chunk.');
      fs.mkdirSync(folder, {recursive: true, mode: 0o700});
      const file = path.join(folder, String(b.index));
      if (fs.existsSync(file) && !fs.readFileSync(file).equals(bytes)) throw Error('A different chunk was already uploaded at this position.');
      fs.writeFileSync(file, bytes, {mode: 0o600});
      json(res, 200, {ok: true}); return true;
    }
    if (route === '/api/cloud/upload/finish') {
      const chunks = Array.from({length: Math.ceil(upload.bytes / TRANSFER_BYTES)}, (_, i) => fs.readFileSync(path.join(folder, String(i))));
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== upload.bytes || sha(bytes) !== upload.sha256) throw Error('The uploaded file fingerprint does not match.');
      const result = merchant.publish(actor, {...b.product, fileBase64: bytes.toString('base64')});
      fs.rmSync(folder, {recursive: true, force: true}); delete c.meta.uploads[b.id];
      json(res, 201, result); return true;
    }
  }
  if (route === '/api/cloud/download/start') {
    const id = store.authorizeDownload(b.request, b.signature), purchase = store.state.purchases[b.request.purchaseId];
    const delivery = purchase.receipt.delivery;
    let file;
    if (delivery) file = merchant.readDelivery(delivery);
    else {const name = downloadFiles[id]; if (!name) throw Error('Download unavailable.'); file = {name, bytes: fs.readFileSync(path.join(root, 'private-products', name)), type: name.endsWith('.zip') ? 'application/zip' : 'text/plain; charset=utf-8'};}
    const token = randomBytes(32).toString('hex');
    c.meta.downloads[sha(token)] = {purchaseId: purchase.id, name: file.name, type: file.type, bytes: file.bytes.length, sha256: sha(file.bytes), expiresAt: Date.now() + 600000};
    json(res, 200, {token, name: file.name, type: file.type, bytes: file.bytes.length, sha256: sha(file.bytes), chunkBytes: TRANSFER_BYTES}); return true;
  }
  if (route === '/api/cloud/download/chunk') {
    if (!TX.test(b.token || '')) throw Error('Invalid download authorization.');
    const ticket = c.meta.downloads[sha(b.token)];
    if (!ticket || ticket.expiresAt <= Date.now() || !store.downloadAllowed(ticket.purchaseId)) throw Error('Download access expired or this purchase was refunded.');
    const p = store.state.purchases[ticket.purchaseId];
    const bytes = p.receipt.delivery ? merchant.readDelivery(p.receipt.delivery).bytes : fs.readFileSync(path.join(root, 'private-products', downloadFiles[p.receipt.product]));
    if (bytes.length !== ticket.bytes || sha(bytes) !== ticket.sha256) throw Error('Download integrity check failed.');
    if (!Number.isInteger(b.index) || b.index < 0 || b.index >= Math.ceil(bytes.length / TRANSFER_BYTES)) throw Error('Invalid download position.');
    res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store'});
    res.end(bytes.subarray(b.index * TRANSFER_BYTES, (b.index + 1) * TRANSFER_BYTES)); return true;
  }
  return false;
}

export function createCloudHandler({env = process.env, vault: suppliedVault, walletExecutor = execute, allowSimulation = false} = {}) {
  let vault = suppliedVault;
  let busy = false;
  return async function handler(req, res) {
    const startedAt = Date.now();
    security(res);
    let directory, lease, stopHeartbeat, ownsBusy = false;
    const abort = new AbortController();
    try {
      const production = env.VERCEL_ENV === 'production';
      const publicURL = new URL(env.VEYLO_PUBLIC_ORIGIN || 'https://veylo-steel.vercel.app');
      if (publicURL.protocol !== 'https:' || publicURL.pathname !== '/' || publicURL.username || publicURL.password || publicURL.search || publicURL.hash) throw Error('Invalid public origin.');
      const hosts = new Set([publicURL.host]);
      for (const value of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) if (value && /^[a-zA-Z0-9.-]+\.vercel\.app$/.test(value)) hosts.add(value);
      if (!hosts.has(req.headers.host)) return json(res, 403, {error: 'Host not allowed.'});
      const url = new URL(req.url, publicURL), route = url.pathname;
      const staticFiles = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/checkout-state.mjs': 'checkout-state.mjs', '/payment-watch.mjs': 'payment-watch.mjs', '/cloud-transport.mjs': 'cloud-transport.mjs'};
      if (req.method === 'GET' && staticFiles[route]) {
        const file = staticFiles[route], type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        let bytes = fs.readFileSync(path.join(root, 'public', file));
        if (file === 'app.js') bytes = Buffer.concat([Buffer.from("import './cloud-transport.mjs';\n"), bytes]);
        res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store'}); res.end(bytes); return;
      }
      if (!route.startsWith('/api/')) return json(res, 404, {error: 'Not found.'});
      if (!['GET', 'POST'].includes(req.method)) return json(res, 405, {error: 'Use GET or POST.'}, {Allow: 'GET, POST'});
      vault ??= new CloudVault(cloudClient(env), env.VEYLO_CLOUD_KEY, {scope: production ? 'main' : 'preview', ttlMs: 300000});
      if (req.method === 'GET' && PUBLIC_READS.has(route)) {
        const files = await readPublicCloudFiles(vault), config = cloudSettings(files, allowSimulation);
        if (route === '/api/cloud/health') return json(res, 200, {ok: true, storage: 'encrypted', network: 'Zcash testnet', mode: production && env.VEYLO_CLOUD_MODE === 'live' && config.active === true ? 'live' : 'scan-only', stateImported: true});
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veylo-public-read-'));
        fs.chmodSync(directory, 0o700);
        restoreCloudFiles(directory, files);
        const noWallet = () => {throw problem('VEYLO_CLOUD_INVALID', 'Public browsing cannot execute wallet operations.');};
        const app = createVeyloApp({requireExistingState: true, env: {
          VEYLO_BIND_HOST: '0.0.0.0', VEYLO_PUBLIC_ORIGIN: `https://${req.headers.host}`,
          VEYLO_DATA_DIR: path.join(directory, 'data'), VEYLO_PAYMENT_MODE: config.paymentMode,
          VEYLO_SELLER_CODE: config.sellerCode, VEYLO_SELLER_ACCOUNT: config.account,
          VEYLO_WALLET_BINARY: 'unavailable-for-public-reads', VEYLO_SELLER_WALLET: path.join(directory, 'wallet'), VEYLO_SELLER_IDENTITY: path.join(directory, 'identity.txt'),
        }, walletFactory: () => ({exclusive: noWallet, run: noWallet, snapshot: noWallet})});
        // Reuse the established public projections; do not expose state files,
        // credentials or purchase records, and never checkpoint a public read.
        const buffered = bufferResponse();
        await app.handler(req, buffered);
        writeResponse(res, buffered);
        return;
      }
      if (busy) return json(res, 503, {code: 'VEYLO_CLOUD_BUSY', error: 'The store is finishing another request. Retry shortly.'}, {'Retry-After': '1'});
      busy = true; ownsBusy = true;
      lease = await vault.acquire();
      stopHeartbeat = vault.startHeartbeat(lease, () => abort.abort());
      const files = await vault.readFiles(lease);
      const config = cloudSettings(files, allowSimulation);
      if (!/^network\s*=\s*"test"\s*$/m.test(files.get('wallet/keys.toml')?.toString('utf8') || '')) throw problem('VEYLO_CLOUD_INVALID', 'Only a testnet wallet can run in this deployment.');
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veylo-request-'));
      fs.chmodSync(directory, 0o700);
      restoreCloudFiles(directory, files);
      const meta = metadata(files);
      prune(meta, directory, Date.now());
      const context = {directory, vault, lease, meta, abort, execute: walletExecutor, app: null,
        deadline: startedAt + 240000, live: production && env.VEYLO_CLOUD_MODE === 'live' && config.active === true,
        operation: null, checkpoint: null,
        requireSpending() {if (!this.live) throw Error('This deployment is scan-only. Refund sending remains on the existing backend until cutover.');},
        async step(key, action) {
          if (!this.operation) throw Error('Reload the page to continue this wallet operation.');
          if (this.operation.steps[key]?.done) return structuredClone(this.operation.steps[key].value);
          const value = await action();
          this.operation.steps[key] = {done: true, value, finishedAt: Date.now()};
          await this.checkpoint();
          throw new CloudPending('Wallet progress saved. Finishing the request.');
        },
      };
      const sessions = new Map(meta.sessions), accountSessions = new Map(meta.accountSessions), limits = new Map(meta.limits);
      context.checkpoint = async () => {
        await vault.assertActive(lease);
        if (context.operation?.refundId) {
          const q = context.app?.store.state.requests[context.operation.refundId];
          if (q?.attemptedAt) context.operation.refundAttempted = true;
        }
        meta.sessions = [...sessions]; meta.accountSessions = [...accountSessions]; meta.limits = [...limits];
        fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify(meta), {mode: 0o600});
        return vault.checkpoint(lease, captureCloudFiles(directory));
      };
      const origin = `https://${req.headers.host}`;
      context.app = createVeyloApp({env: {VEYLO_BIND_HOST: '0.0.0.0', VEYLO_PUBLIC_ORIGIN: origin,
        VEYLO_DATA_DIR: path.join(directory, 'data'), VEYLO_PAYMENT_MODE: config.paymentMode,
        VEYLO_SELLER_CODE: config.sellerCode, VEYLO_WALLET_BINARY: path.join(process.cwd(), 'cloud-bin', 'zcash-devtool'),
        VEYLO_SELLER_WALLET: path.join(directory, 'wallet'), VEYLO_SELLER_IDENTITY: path.join(directory, 'identity.txt'), VEYLO_SELLER_ACCOUNT: config.account},
        requireExistingState: true, sessions, accountSessions, limits, flush: () => context.checkpoint(),
        walletFactory: cfg => new DurableWallet(cfg, context),
        jobsFactory: (store, accounts) => new DurableConnectorJobs(store, accounts, context),
        remoteWalletFactory: (actor, jobs) => new DurableRemoteWallet(actor, jobs, context),
        bodyLimit: name => name === '/api/cloud/upload/chunk' ? 750000 : 32768,
        route: args => cloudRoutes(context, args),
        onError: async (error, _req, buffered) => {
          if (error.code === 'VEYLO_CLOUD_PENDING') {json(buffered, 202, {pending: true, retryAfterMs: 1000, message: error.message}); return true;}
          if (String(error.code || '').startsWith('VEYLO_CLOUD_')) throw error;
          return false;
        },
      });
      let operation, buffered;
      if (!route.startsWith('/api/connector/')) {
        const id = req.headers['x-veylo-operation'];
        if (typeof id !== 'string' || !UUID.test(id)) {
          if (req.method === 'POST' || route === '/api/seller') return json(res, 400, {error: 'Reload Veylo to use the updated cloud connection.'});
        } else {
          let raw = '';
          if (req.method === 'POST') {
            if (req.body !== undefined) raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
            else {for await (const chunk of req) {raw += chunk; if (Buffer.byteLength(raw) > 750000) throw Error('Request too large.');}}
            if (Buffer.byteLength(raw) > 750000) throw Error('Request too large.');
            req.body = raw ? JSON.parse(raw) : {};
          }
          const binding = createHmac('sha256', vault.indexKey).update(JSON.stringify([req.method, req.url, req.headers.cookie || '', raw])).digest('hex');
          operation = meta.operations[id];
          if (operation && operation.binding !== binding) return json(res, 409, {error: 'Operation identifier was reused for a different request.'});
          operation ??= meta.operations[id] = {binding, createdAt: Date.now(), expiresAt: Date.now() + 86400000, steps: {}, values: {}};
          context.operation = operation;
          if (operation.response) {
            const protectedSeller = route.startsWith('/api/seller/') && !['/api/seller/login', '/api/seller/logout'].includes(route) || route === '/api/seller' || route === '/api/store-account' ||
              route.startsWith('/api/store-account/') && !['/api/store-account/register', '/api/store-account/login', '/api/store-account/logout'].includes(route);
            if (protectedSeller && !context.app.sellerActor(req)) return json(res, 401, {error: 'Seller sign-in required.'});
            buffered = bufferResponse();
            buffered.statusCode = operation.response.status;
            buffered.headers = new Map(operation.response.headers);
            buffered.payload = Buffer.from(operation.response.base64, 'base64');
          }
        }
      }
      if (!buffered) {
        buffered = bufferResponse();
        await context.app.handler(req, buffered);
        if (route === '/api/seller/send-refund' && operation?.refundId) {
          const q = context.app.store.state.requests[operation.refundId];
          if (buffered.statusCode === 200 && q?.connectorJob && q.status === 'sending') json(buffered, 202, {pending: true, retryAfterMs: 1500, message: 'Awaiting the seller’s terminal approval.'});
        }
        if (operation && buffered.statusCode !== 202 && buffered.payload.length < 2 * 1048576 && route !== '/api/cloud/download/chunk') {
          operation.response = {status: buffered.statusCode, headers: [...buffered.headers], base64: buffered.payload.toString('base64')};
        }
        if (operation && buffered.statusCode !== 202) operation.completedAt = Date.now();
        // Reclaim only chunks which the current committed snapshot does not use.
        // A failed later checkpoint therefore cannot corrupt that snapshot.
        const rows = await vault.client.execute({sql: 'SELECT id FROM veylo_cloud_chunks_v1 WHERE scope = ? AND id > ? ORDER BY id LIMIT 128', args: [vault.scope, meta.gcCursor || '']});
        const keep = new Set(lease.manifest?.files.flatMap(f => f.chunks) || []);
        const discard = rows.rows.map(row => row.id).filter(id => !keep.has(id));
        if (discard.length) await vault.client.execute({sql: `DELETE FROM veylo_cloud_chunks_v1 WHERE scope = ? AND id IN (${discard.map(() => '?').join(',')})
          AND EXISTS (SELECT 1 FROM veylo_cloud_root_v1 WHERE scope = ? AND owner = ? AND fence = ? AND revision = ? AND lease_until > unixepoch()*1000)`,
          args: [vault.scope, ...discard, vault.scope, lease.owner, lease.fence, lease.revision]});
        meta.gcCursor = rows.rows.length ? rows.rows.at(-1).id : '';
        await context.checkpoint();
      }
      // Only publish the response after the application changes and cookies are durable.
      await vault.assertActive(lease);
      stopHeartbeat?.();
      await vault.release(lease); lease = null;
      writeResponse(res, buffered);
    } catch (error) {
      const code = String(error.code || '');
      const known = ['VEYLO_CLOUD_BUSY', 'VEYLO_CLOUD_LEASE_LOST', 'VEYLO_CLOUD_NOT_IMPORTED', 'VEYLO_CLOUD_INTEGRITY', 'VEYLO_CLOUD_INVALID'];
      json(res, 503, {code: known.includes(code) ? code : 'VEYLO_CLOUD_RETRY',
        error: code === 'VEYLO_CLOUD_BUSY' ? 'The store is finishing another request. Retry shortly.' : code === 'VEYLO_CLOUD_NOT_IMPORTED' ? error.message : 'Cloud storage is temporarily unavailable. No completed payment is being claimed.'}, {'Retry-After': '2'});
    } finally {
      stopHeartbeat?.();
      if (lease) await vault.release(lease).catch(() => {});
      if (directory) fs.rmSync(directory, {recursive: true, force: true});
      if (ownsBusy) busy = false;
    }
  };
}

let deployedHandler;
export default function handler(req, res) {deployedHandler ??= createCloudHandler(); return deployedHandler(req, res);}
