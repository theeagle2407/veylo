import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {randomBytes, randomUUID, generateKeyPairSync, sign, createHash} from 'node:crypto';
import {createClient} from '@libsql/client';
import {CloudVault} from '../cloud-state.mjs';
import {createCloudHandler, readPublicCloudFiles, TRANSFER_BYTES} from '../cloud-runtime.mjs';
import {createCloudFetch} from '../public/cloud-transport.mjs';
import {newState, requestPayload} from '../core.mjs';

// Wallet subprocesses and broadcasts in this suite are deterministic fixtures.
// The deployed native wallet must also pass its separate Preview check before cutover.

const ORIGIN = 'https://veylo-steel.vercel.app';
const ACCOUNT = '6be4ea81-7f3a-44ee-9801-312ec18976e3';
const ADDRESS = 'utest1' + 'a'.repeat(90);
const CODE = 'private-test-access-code';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, {live = true, simulation = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veylo-runtime-test-'));
  const clients = [], key = randomBytes(32).toString('hex'), audit = [], counters = {};
  let checkpointFault, sendFault = false;
  const connect = () => {const client = createClient({url: 'file:' + path.join(dir, 'cloud.sqlite')}); clients.push(client); return client;};
  class AuditedVault extends CloudVault {
    async checkpoint(lease, input) {
      const saved = await super.checkpoint(lease, input);
      const files = input instanceof Map ? input : new Map(Object.entries(input));
      audit.push({state: JSON.parse(files.get('data/state.json').toString()), meta: files.has('runtime.json') ? JSON.parse(files.get('runtime.json').toString()) : {}});
      if (checkpointFault?.(audit.at(-1))) {checkpointFault = null; throw Object.assign(Error('Injected lost acknowledgement'), {code: 'VEYLO_CLOUD_RETRY'});}
      return saved;
    }
  }
  const vault = () => new AuditedVault(connect(), key, {scope: live ? 'main' : 'preview'});
  const first = vault(), lease = await first.acquire();
  const state = newState();
  await first.checkpoint(lease, new Map([
    ['data/state.json', Buffer.from(JSON.stringify(state))],
    ['config.json', Buffer.from(JSON.stringify({schema: 1, paymentMode: simulation ? 'simulation' : 'testnet', account: ACCOUNT, sellerCode: CODE, active: live}))],
    ['wallet/keys.toml', Buffer.from('network = "test"\nbirthday = 4465026\n')],
    ['wallet/data.sqlite', Buffer.from('fixture wallet bytes; the test never executes a real wallet')],
    ['identity.txt', Buffer.from('test fixture identity, not a wallet secret')],
  ]));
  await first.release(lease);
  let height = 100, invoice, outgoing;
  const native = async (_binary, args) => {
    const command = args[3]; counters[command] = (counters[command] || 0) + 1;
    if (command === 'get-info') return {stdout: JSON.stringify({chain_name: 'test', chain_tip_height: height}), stderr: 'WALLET_BRANCH: Nu7 (77190ad9)\nSERVER_BRANCH: 77190ad9'};
    if (command === 'generate-address') return {stdout: 'Address: ' + ADDRESS, stderr: 'Network: testnet'};
    if (command === 'sync') {fs.writeFileSync(path.join(args[2], 'synced-height'), String(height)); return {stdout: 'Latest block height is ' + height, stderr: ''};}
    if (command === 'enhance') return {stdout: '', stderr: ''};
    const transactions = [];
    if (invoice) transactions.push({txid: 'a'.repeat(64), minedHeight: 101, outputs: [{index: 0, pool: 'Ironwood', receivedBy: ACCOUNT, value: invoice.value, memo: invoice.memo, change: false}]});
    if (outgoing) transactions.push({txid: 'b'.repeat(64), minedHeight: 145, outputs: [{index: 0, pool: 'Ironwood', sentFrom: ACCOUNT, value: outgoing.value, memo: outgoing.memo, address: outgoing.address, change: false}]});
    if (command === 'list-tx') {
      if (args.includes('--json')) return {stdout: JSON.stringify(transactions.map(tx => ({txid: tx.txid, mined_height: tx.minedHeight}))), stderr: ''};
      let text = 'Transactions:\n';
      for (const tx of transactions) {
        text += tx.txid + '\nMined: ' + tx.minedHeight + ' (fixture)\n';
        for (const o of tx.outputs) text += `Output ${o.index} (${o.pool})\nValue: 0.00100000 TAZ\n${o.sentFrom ? 'Sent from' : 'Received by'} account: ${ACCOUNT} (fixture)\n${o.address ? 'To: ' + o.address + '\n' : ''}Memo: Memo::Text("${o.memo}")\n`;
      }
      return {stdout: text, stderr: ''};
    }
    if (command === 'send') {
      const latest = audit.at(-1);
      const q = Object.values(latest.state.requests).find(q => q.status === 'sending');
      assert.ok(q, 'refund intent must be durably committed before send');
      assert.ok(Object.values(latest.meta.operations).some(op => op.sendStarted && op.refundId === q.id));
      outgoing = {value: Number(args[args.indexOf('--value') + 1]), memo: args[args.indexOf('--memo') + 1], address: args[args.indexOf('--address') + 1]};
      if (sendFault) throw Error('fixture response lost after wallet broadcast');
      return {stdout: 'b'.repeat(64), stderr: ''};
    }
    throw Error('Unexpected test wallet command: ' + command);
  };
  const handler = (options = {}) => createCloudHandler({env: {VERCEL_ENV: live ? 'production' : 'preview', VEYLO_CLOUD_MODE: live ? 'live' : 'scan'}, vault: vault(), walletExecutor: native, allowSimulation: simulation, ...options});
  t.after(() => {for (const client of clients) client.close(); fs.rmSync(dir, {recursive: true, force: true});});
  async function read() {const v = vault(), l = await v.acquire(); try {return await v.readFiles(l);} finally {await v.release(l);}}
  async function change(fn) {const v = vault(), l = await v.acquire(); try {const files = await v.readFiles(l); await fn(files); await v.checkpoint(l, files);} finally {await v.release(l);}}
  return {handler, native, read, change, counters, audit, height: n => height = n, paid: async value => {invoice = value; height = 140; await change(files => {const meta = JSON.parse(files.get('runtime.json')); if (meta.walletSnapshot) meta.walletSnapshot.finishedAt = Date.now() - 11000; files.set('runtime.json', Buffer.from(JSON.stringify(meta)));});},
    fault: fn => checkpointFault = fn, failSend: () => sendFault = true, key: state.publicKey, vault, storage: first.client};
}

async function call(handler, route, body, {cookie = '', id = randomUUID(), connector, headers: extra = {}} = {}) {
  const req = Readable.from([]);
  Object.assign(req, {method: body === undefined ? 'GET' : 'POST', url: route, body,
    headers: {host: new URL(ORIGIN).host, ...(connector ? {authorization: 'Bearer ' + connector} : {origin: ORIGIN, cookie, 'x-veylo-operation': id}), 'content-type': 'application/json', ...extra}, socket: {remoteAddress: '127.0.0.1'}});
  const headers = new Map();
  let status = 200, bytes = Buffer.alloc(0);
  const response = {setHeader: (k, v) => headers.set(k.toLowerCase(), v), writeHead(code, h = {}) {status = code; for (const [k, v] of Object.entries(h)) headers.set(k.toLowerCase(), v);}, set statusCode(n) {status = n;}, get statusCode() {return status;}, end(b = '') {bytes = Buffer.from(b);}};
  await handler(req, response);
  return {status, bytes, headers, json: () => JSON.parse(bytes.toString())};
}
async function finish(f, route, body, options = {}, drain) {
  const id = options.id || randomUUID();
  for (let i = 0; i < 20; i++) {
    const r = await call(f.handler(), route, body, {...options, id});
    if (r.status !== 202 && !(r.status === 503 && ['VEYLO_CLOUD_RETRY', 'VEYLO_CLOUD_BUSY'].includes(r.json().code))) return r;
    if (drain) await drain();
  }
  throw Error('Operation did not finish within the fixture limit.');
}
async function owner(f) {const r = await finish(f, '/api/seller/login', {code: CODE}); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0];}
function buyer() {
  const keys = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  return {key: keys.publicKey.export({format: 'jwk'}), sign: payload => sign('sha256', Buffer.from(payload), {key: keys.privateKey, dsaEncoding: 'ieee-p1363'}).toString('base64url')};
}
async function purchase(f, productId = 'fieldnotes', drain) {
  const b = buyer();
  const r = await finish(f, '/api/purchases', {productId, key: b.key}, {}, drain);
  assert.equal(r.status, 201, r.bytes.toString());
  return {...b, invoice: r.json()};
}
async function refund(f, p, cookie) {
  await f.paid(p.invoice);
  const paid = await finish(f, '/api/check-payment', {id: p.invoice.id, token: p.invoice.token});
  assert.equal(paid.json().status, 'confirmed', paid.bytes.toString());
  const c = (await finish(f, '/api/challenges', {id: p.invoice.id})).json();
  const request = {purchaseId: p.invoice.id, nonce: c.nonce, destination: ADDRESS, reason: 'Wrong product edition'};
  const r = await finish(f, '/api/refunds', {request, signature: p.sign(requestPayload(request))});
  assert.equal(r.status, 201, r.bytes.toString());
  return {id: r.json().id, cookie};
}

test('cloud cookies and merchant identity survive cold instances; logout invalidates cached private responses', async t => {
  const f = await fixture(t), cookie = await owner(f), id = randomUUID();
  const first = await finish(f, '/api/seller/products', undefined, {cookie, id}); assert.equal(first.status, 200);
  const catalog = await finish(f, '/api/catalog'); assert.deepEqual(catalog.json().merchantKey, f.key);
  await finish(f, '/api/seller/logout', {}, {cookie});
  assert.equal((await finish(f, '/api/seller/products', undefined, {cookie, id})).status, 401);
});

test('invoice creation resumes across cold instances and lost acknowledgements without duplicate purchases', async t => {
  const f = await fixture(t), b = buyer(), body = {key: b.key, productId: 'fieldnotes'}, id = randomUUID();
  f.fault(({state, meta}) => Object.keys(state.purchases).length === 1 && meta.operations[id]?.response);
  const r = await finish(f, '/api/purchases', body, {id}); assert.equal(r.status, 201, r.bytes.toString());
  const repeated = await finish(f, '/api/purchases', body, {id}); assert.deepEqual(repeated.json(), r.json());
  assert.equal(f.counters['generate-address'], 1);
  const files = await f.read(), saved = JSON.parse(files.get('data/state.json'));
  assert.equal(Object.keys(saved.purchases).length, 1);
  assert.equal(files.get('wallet/synced-height').toString(), '100');
  assert.equal((await finish(f, '/api/purchases', {...body, productId: 'contour'}, {id})).status, 409);
});

test('a cloud payment issues its portable receipt only after matching wallet evidence satisfies ten confirmations', async t => {
  const f = await fixture(t), p = await purchase(f);
  const waiting = await finish(f, '/api/check-payment', {id: p.invoice.id, token: p.invoice.token});
  assert.equal(waiting.json().status, 'awaiting_payment');
  await f.paid(p.invoice);
  await f.change(files => {const meta = JSON.parse(files.get('runtime.json')); delete meta.walletSnapshot; files.set('runtime.json', Buffer.from(JSON.stringify(meta)));});
  const paid = await finish(f, '/api/check-payment', {id: p.invoice.id, token: p.invoice.token});
  assert.equal(paid.json().status, 'confirmed'); assert.equal(paid.json().receipt.payment.txid, 'a'.repeat(64));
  assert.equal(paid.json().receipt.id, p.invoice.id); assert.ok(paid.json().receipt.signature);
});

test('native refunds checkpoint intent before spending; retries cannot broadcast a second payment', async t => {
  const f = await fixture(t), cookie = await owner(f), p = await purchase(f);
  const q = await refund(f, p, cookie), id = randomUUID();
  const r = await finish(f, '/api/seller/send-refund', {id: q.id}, {cookie, id});
  assert.equal(r.status, 200, r.bytes.toString()); assert.equal(r.json().status, 'broadcast');
  assert.equal((await finish(f, '/api/seller/send-refund', {id: q.id}, {cookie, id})).json().txid, 'b'.repeat(64));
  assert.equal((await finish(f, '/api/seller/send-refund', {id: q.id}, {cookie})).status, 400);
  assert.equal(f.counters.send, 1);
});

test('an uncertain native send remains unknown across restarts and is never automatically repeated', async t => {
  const f = await fixture(t), cookie = await owner(f), p = await purchase(f), q = await refund(f, p, cookie);
  f.failSend();
  assert.equal((await finish(f, '/api/seller/send-refund', {id: q.id}, {cookie})).status, 400);
  assert.equal((await finish(f, '/api/seller/send-refund', {id: q.id}, {cookie})).status, 400);
  const state = JSON.parse((await f.read()).get('data/state.json'));
  assert.equal(state.requests[q.id].status, 'unknown'); assert.equal(f.counters.send, 1);
});

test('a lost storage acknowledgement before refund sending blocks all send attempts', async t => {
  const f = await fixture(t), cookie = await owner(f), p = await purchase(f), q = await refund(f, p, cookie);
  f.fault(({state, meta}) => state.requests[q.id]?.status === 'sending' && !Object.values(meta.operations).some(op => op.refundId === q.id && op.sendStarted));
  const r = await finish(f, '/api/seller/send-refund', {id: q.id}, {cookie});
  assert.equal(r.status, 400); assert.equal(f.counters.send || 0, 0);
  assert.equal((await finish(f, '/api/seller/send-refund', {id: q.id}, {cookie})).status, 400);
  assert.equal(f.counters.send || 0, 0);
});

test('public browsing stays available during wallet work without releasing or changing its lease', {timeout: 10000}, async t => {
  const f = await fixture(t), cookie = await owner(f);
  let release, started;
  const ready = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve);
  const handler = f.handler({walletExecutor: async (...args) => {if (args[1][3] === 'sync') {started(); await gate;} return f.native(...args);}});
  const id = randomUUID();
  // Complete the network metadata stage before pausing the subsequent wallet sync.
  assert.equal((await call(f.handler(), '/api/cloud/wallet-check', {}, {cookie, id})).status, 202);
  t.after(() => release());
  const pending = call(handler, '/api/cloud/wallet-check', {}, {cookie, id});
  await ready;
  const before = (await f.storage.execute('SELECT owner, fence, revision, manifest FROM veylo_cloud_root_v1 WHERE scope = \'main\'')).rows[0];
  const replies = await Promise.all([
    call(handler, '/api/catalog'), call(handler, '/api/notices'), call(handler, '/api/reviews'),
    call(f.handler(), '/api/product?id=fieldnotes'), call(f.handler(), '/api/cloud/health'),
  ]);
  for (const reply of replies) {
    assert.equal(reply.status, 200, reply.bytes.toString());
    assert.ok(!reply.bytes.includes(Buffer.from(CODE)), 'public replies cannot disclose the seller code');
    assert.ok(!reply.bytes.includes(Buffer.from('PRIVATE KEY')), 'public replies cannot disclose signing keys');
  }
  assert.equal(replies[0].json().paymentMode, 'testnet');
  assert.equal(replies[3].json().stats.purchases, 0);
  const after = (await f.storage.execute('SELECT owner, fence, revision, manifest FROM veylo_cloud_root_v1 WHERE scope = \'main\'')).rows[0];
  assert.deepEqual(after, before, 'browsing must not write state or release the active wallet lease');
  assert.equal((await call(handler, '/api/seller')).status, 503);
  assert.equal((await call(f.handler(), '/api/challenges', {id: randomUUID()})).status, 503);
  release(); assert.equal((await pending).status, 202);
  assert.equal((await finish(f, '/api/cloud/wallet-check', {}, {cookie, id})).status, 200);
});

test('public reads recover from concurrent chunk collection and reject damaged committed data', async t => {
  const f = await fixture(t), reader = f.vault();
  const execute = reader.client.execute.bind(reader.client);
  let raced = false;
  reader.client.execute = async statement => {
    if (!raced && typeof statement === 'object' && statement.sql.startsWith('SELECT id, payload, plain_bytes')) {
      raced = true;
      await f.change(files => {
        const state = JSON.parse(files.get('data/state.json'));
        state.notices.push({id: 'new-committed-notice', product: 'fieldnotes', version: '1.0'});
        files.set('data/state.json', Buffer.from(JSON.stringify(state)));
      });
      const root = (await execute({sql: 'SELECT revision, manifest FROM veylo_cloud_root_v1 WHERE scope = ?', args: ['main']})).rows[0];
      const current = reader.decodeManifest(root.manifest, Number(root.revision));
      const keep = [...new Set(current.files.flatMap(file => file.chunks))];
      await execute({sql: `DELETE FROM veylo_cloud_chunks_v1 WHERE scope = ? AND id NOT IN (${keep.map(() => '?').join(',')})`, args: ['main', ...keep]});
    }
    return execute(statement);
  };
  const files = await readPublicCloudFiles(reader);
  assert.ok(raced);
  assert.equal(JSON.parse(files.get('data/state.json')).notices[0].id, 'new-committed-notice');
  assert.deepEqual([...files.keys()].sort(), ['config.json', 'data/state.json']);
  const root = (await execute({sql: 'SELECT revision, manifest FROM veylo_cloud_root_v1 WHERE scope = ?', args: ['main']})).rows[0];
  const manifest = reader.decodeManifest(root.manifest, Number(root.revision));
  const id = manifest.files.find(file => file.name === 'data/state.json').chunks[0];
  await execute({sql: 'UPDATE veylo_cloud_chunks_v1 SET payload = ? WHERE scope = ? AND id = ?', args: [Buffer.from('damaged'), 'main', id]});
  await assert.rejects(readPublicCloudFiles(reader), error => error.code === 'VEYLO_CLOUD_INTEGRITY');
});

test('public reads are fresh and do not persist read-operation records', async t => {
  const f = await fixture(t), handler = f.handler();
  const before = (await f.storage.execute("SELECT fence, revision FROM veylo_cloud_root_v1 WHERE scope = 'main'")).rows[0];
  assert.equal((await call(handler, '/api/notices')).json().length, 0);
  const after = (await f.storage.execute("SELECT fence, revision FROM veylo_cloud_root_v1 WHERE scope = 'main'")).rows[0];
  assert.deepEqual(after, before);
  await f.change(files => {
    const state = JSON.parse(files.get('data/state.json'));
    state.notices.push({id: 'fresh-notice', product: 'fieldnotes', version: '1.0'});
    files.set('data/state.json', Buffer.from(JSON.stringify(state)));
  });
  assert.equal((await call(handler, '/api/notices')).json()[0].id, 'fresh-notice');
  assert.equal(f.counters.sync || 0, 0);
});

test('Preview syncs the imported wallet but cannot send a refund', async t => {
  const f = await fixture(t, {live: false}), cookie = await owner(f);
  const check = await finish(f, '/api/cloud/wallet-check', {}, {cookie}); assert.equal(check.status, 200);
  assert.equal(check.json().transactionsSent, 0); assert.equal(check.json().chainHeight, 100);
  assert.equal((await finish(f, '/api/seller/send-refund', {id: randomUUID()}, {cookie})).status, 400);
  assert.equal(f.counters.send || 0, 0);
});

test('remote seller jobs release the lease so connector requests can complete invoices and approved refunds', async t => {
  const f = await fixture(t);
  const registration = await finish(f, '/api/store-account/register', {username: 'remote_seller', name: 'Remote seller', password: 'a long independent password'});
  const cookie = registration.headers.get('set-cookie')[0].split(';')[0];
  const paired = await finish(f, '/api/store-account/pair', {}, {cookie}), token = paired.json().token;
  const connector = async (route, body) => {const r = await call(f.handler(), '/api/connector/' + route, body, {connector: token}); assert.equal(r.status, 200, r.bytes.toString()); return r.json();};
  await connector('heartbeat', {network: 'test', height: 100, account: ACCOUNT, protocol: 2});
  const published = await finish(f, '/api/seller/products/publish', {name: 'Remote pack', description: 'A small product owned by an independent seller.', category: 'Other', version: '1', price: '0.001', fileName: 'pack.txt', fileBase64: Buffer.from('Download').toString('base64')}, {cookie});
  assert.equal(published.status, 201, published.bytes.toString());
  let invoice, sends = 0;
  const drain = async () => {
    for (const job of (await connector('poll', {})).jobs) {
      assert.equal((await connector('claim', {id: job.id})).claimed, true);
      const value = job.kind === 'address' ? {stdout: 'Address: ' + ADDRESS, stderr: 'Network: testnet'} : job.kind === 'send' ? (sends++, 'c'.repeat(64)) : {height: invoice ? 140 : 100, transactions: invoice ? [{txid: 'd'.repeat(64), minedHeight: 101, outputs: [{index: 0, pool: 'Ironwood', receivedBy: ACCOUNT, value: invoice.value, memo: invoice.memo, change: false}]}] : []};
      await connector('complete', {id: job.id, result: {value}});
    }
  };
  const p = await purchase(f, published.json().id, drain); invoice = p.invoice;
  const paid = await finish(f, '/api/check-payment', {id: invoice.id, token: invoice.token}, {}, drain);
  assert.equal(paid.json().status, 'confirmed', paid.bytes.toString());
  const c = (await finish(f, '/api/challenges', {id: invoice.id})).json();
  const request = {purchaseId: invoice.id, nonce: c.nonce, destination: ADDRESS, reason: 'Wrong edition'};
  const q = (await finish(f, '/api/refunds', {request, signature: p.sign(requestPayload(request))})).json();
  const result = await finish(f, '/api/seller/send-refund', {id: q.id}, {cookie}, drain);
  assert.equal(result.status, 200, result.bytes.toString()); assert.equal(result.json().status, 'broadcast'); assert.equal(result.json().txid, 'c'.repeat(64)); assert.equal(sends, 1);
  assert.equal((await finish(f, '/api/seller/send-refund', {id: q.id}, {cookie})).status, 400);
});

test('the full 8 MiB product survives chunked upload and authorized download below Vercel payload limits', async t => {
  const f = await fixture(t, {simulation: true}), cookie = await owner(f);
  let calls = 0;
  const bridge = async (input, init) => {
    const url = new URL(input, ORIGIN);
    if (init?.body) assert.ok(Buffer.byteLength(init.body) < 750000);
    const r = await call(f.handler(), url.pathname + url.search, init?.body ? JSON.parse(init.body) : undefined, {cookie, id: new Headers(init?.headers).get('x-veylo-operation') || randomUUID()});
    assert.ok(r.bytes.length < 1048576); calls++;
    return new Response(r.bytes, {status: r.status, headers: Object.fromEntries([...r.headers].filter(([k]) => k !== 'set-cookie'))});
  };
  const cloud = createCloudFetch(bridge, {origin: ORIGIN, pause: async () => {}});
  const bytes = randomBytes(8 * 1048576);
  const published = await cloud('/api/seller/products/publish', {method: 'POST', body: JSON.stringify({name: 'Full file', description: 'A complete eight megabyte file used only in this automated test.', category: 'Other', version: '1', price: '0.001', fileName: 'full.zip', fileBase64: bytes.toString('base64')})});
  const product = await published.json(); assert.equal(published.status, 201, JSON.stringify(product)); assert.equal(product.fileSize, bytes.length);
  const p = await purchase(f, product.id);
  const receipt = await finish(f, '/api/simulate-payment', {id: p.invoice.id}); assert.equal(receipt.status, 200);
  const challenge = (await finish(f, '/api/challenges', {id: p.invoice.id})).json();
  const request = {purchaseId: p.invoice.id, nonce: challenge.nonce};
  const signature = p.sign(JSON.stringify(['veylo.download.v1', request.purchaseId, request.nonce]));
  const downloaded = await cloud('/api/download', {method: 'POST', body: JSON.stringify({request, signature})});
  assert.equal(downloaded.status, 200); assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())), hash(bytes));
  assert.ok(calls >= 35);
});

test('download chunks recheck refund access even when the same operation identifier is replayed', async t => {
  const f = await fixture(t, {simulation: true}), p = await purchase(f);
  await finish(f, '/api/simulate-payment', {id: p.invoice.id});
  const c = (await finish(f, '/api/challenges', {id: p.invoice.id})).json();
  const request = {purchaseId: p.invoice.id, nonce: c.nonce};
  const start = await finish(f, '/api/cloud/download/start', {request, signature: p.sign(JSON.stringify(['veylo.download.v1', request.purchaseId, request.nonce]))});
  assert.equal(start.status, 200, start.bytes.toString());
  const body = {token: start.json().token, index: 0}, id = randomUUID();
  assert.equal((await finish(f, '/api/cloud/download/chunk', body, {id})).status, 200);
  await f.change(files => {const state = JSON.parse(files.get('data/state.json')); state.requests.fixture = {id: 'fixture', purchaseId: p.invoice.id, status: 'simulated'}; files.set('data/state.json', Buffer.from(JSON.stringify(state)));});
  assert.equal((await finish(f, '/api/cloud/download/chunk', body, {id})).status, 400);
});

test('upload tokens and completed pairing responses remain bound to the authenticated seller', async t => {
  const f = await fixture(t), cookie = await owner(f), data = randomBytes(TRANSFER_BYTES);
  const upload = (await finish(f, '/api/cloud/upload/start', {bytes: data.length, sha256: hash(data)}, {cookie})).json();
  const register = await finish(f, '/api/store-account/register', {username: 'another_store', name: 'Another store', password: 'a completely separate password'});
  const other = register.headers.get('set-cookie')[0].split(';')[0], id = randomUUID();
  const pair = await finish(f, '/api/store-account/pair', {}, {cookie: other, id});
  const token = pair.json().token;
  await call(f.handler(), '/api/connector/heartbeat', {network: 'test', height: 100, account: ACCOUNT, protocol: 2}, {connector: token});
  const wrong = await finish(f, '/api/cloud/upload/chunk', {id: upload.id, index: 0, base64: data.toString('base64')}, {cookie: other});
  assert.equal(wrong.status, 400); assert.match(wrong.json().error, /Upload expired/);
  await finish(f, '/api/store-account/logout', {}, {cookie: other});
  assert.equal((await finish(f, '/api/store-account/pair', {}, {cookie: other, id})).status, 401);
});

test('transport keeps one operation identifier through pending, busy and network retries', async () => {
  const seen = [];
  let n = 0;
  const fetch = createCloudFetch(async (_input, init) => {seen.push(new Headers(init.headers).get('x-veylo-operation')); n++;
    if (n === 1) throw Error('transient network failure');
    return n === 2 ? Response.json({code: 'VEYLO_CLOUD_BUSY'}, {status: 503}) : n === 3 ? Response.json({pending: true}, {status: 202}) : Response.json({ok: true});
  }, {origin: ORIGIN, pause: async () => {}});
  assert.equal((await fetch('/api/purchases', {method: 'POST', body: '{}'})).status, 200);
  assert.equal(new Set(seen).size, 1); assert.equal(seen.length, 4);
});

test('repeated storage failures surface after bounded retries instead of spinning for ten minutes', async () => {
  let calls = 0;
  const fetch = createCloudFetch(async () => {calls++; return Response.json({code: 'VEYLO_CLOUD_RETRY', error: 'storage unavailable'}, {status: 503});}, {origin: ORIGIN, pause: async () => {}});
  const response = await fetch('/api/catalog');
  assert.equal(response.status, 503); assert.equal(calls, 4);
});

test('browser wallet requests queue while public browsing can finish independently', async () => {
  let release, began;
  const gate = new Promise(resolve => release = resolve), started = new Promise(resolve => began = resolve);
  const seen = [];
  const cloud = createCloudFetch(async (input) => {
    seen.push(input);
    if (input === '/api/seller') {began(); await gate;}
    return Response.json({ok: true});
  }, {origin: ORIGIN});
  const first = cloud('/api/seller');
  await started;
  const second = cloud('/api/challenges', {method: 'POST', body: '{}'});
  try {
    assert.equal((await cloud('/api/catalog')).status, 200);
    assert.deepEqual(seen, ['/api/seller', '/api/catalog']);
  } finally {release();}
  await Promise.all([first, second]);
  assert.deepEqual(seen, ['/api/seller', '/api/catalog', '/api/challenges']);
});

test('wait messages distinguish contention from saved wallet progress and clear on completion', async () => {
  const waits = [], ended = [];
  let count = 0;
  const cloud = createCloudFetch(async () => ++count === 1
    ? Response.json({code: 'VEYLO_CLOUD_BUSY'}, {status: 503})
    : count === 2 ? Response.json({pending: true, message: 'Wallet progress saved. Finishing the request.'}, {status: 202})
    : Response.json({ok: true}), {
    origin: ORIGIN, pause: async () => {},
    onWait: (message, id) => waits.push({message, id}), onWaitEnd: id => ended.push(id),
  });
  await cloud('/api/check-payment', {method: 'POST', body: '{}'});
  assert.match(waits[0].message, /another request/i);
  assert.doesNotMatch(waits[0].message, /wallet|saved/i);
  assert.equal(waits[1].message, 'Wallet progress saved. Finishing the request.');
  assert.equal(waits[0].id, waits[1].id);
  assert.deepEqual(ended, [waits[0].id]);
});

test('a failed queued request releases the next operation and clears its wait notice', async () => {
  const waits = [], ended = [], seen = [];
  const cloud = createCloudFetch(async input => {
    seen.push(input);
    if (input === '/api/seller') return Response.json({code: 'VEYLO_CLOUD_RETRY', error: 'Storage unavailable'}, {status: 503});
    return Response.json({ok: true});
  }, {origin: ORIGIN, pause: async () => {}, onWait: (message, id) => waits.push({message, id}), onWaitEnd: id => ended.push(id)});
  const first = cloud('/api/seller'), second = cloud('/api/challenges', {method: 'POST', body: '{}'});
  assert.equal((await first).status, 503);
  assert.equal((await second).status, 200);
  assert.deepEqual(seen, ['/api/seller', '/api/seller', '/api/seller', '/api/seller', '/api/challenges']);
  assert.equal(waits.length, 3);
  for (const wait of waits) assert.doesNotMatch(wait.message, /wallet|saved/i);
  assert.deepEqual(ended, [waits[0].id]);
});
