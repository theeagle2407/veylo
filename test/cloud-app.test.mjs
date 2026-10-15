import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createVeyloApp} from '../server.mjs';
import {Store, newState, requestPayload} from '../core.mjs';
import {Payments} from '../payments.mjs';

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veylo-cloud-app-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function create(t, options = {}) {
  const dir = folder(t);
  return {dir, options: {env: {VEYLO_DATA_DIR: dir, VEYLO_PAYMENT_MODE: 'simulation', VEYLO_SELLER_CODE: 'test-access-code'}, ...options}};
}
async function request(app, route, body, cookie = '', extra = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, {method: body === undefined ? 'GET' : 'POST', url: route,
    headers: {host: '127.0.0.1:3002', origin: 'http://127.0.0.1:3002', 'content-type': 'application/json', cookie},
    socket: {remoteAddress: '127.0.0.1'}, ...extra});
  const headers = new Map();
  let status = 200, value = Buffer.alloc(0);
  const res = {setHeader(name, data) {headers.set(name.toLowerCase(), data);},
    writeHead(code, data = {}) {status = code; for (const [k, v] of Object.entries(data)) this.setHeader(k, v);},
    end(data = '') {value = Buffer.from(data);}};
  await app.handler(req, res);
  return {status, headers, bytes: value, json: () => JSON.parse(value.toString('utf8'))};
}
function refund() {
  const store = new Store(), keys = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const purchase = store.createPurchase(keys.publicKey.export({format: 'jwk'}));
  store.simulatePayment(purchase.id);
  const r = {purchaseId: purchase.id, nonce: store.issueChallenge(purchase.id).nonce,
    destination: 'utest1' + 'a'.repeat(90), reason: 'Incorrect edition'};
  const signature = sign('sha256', Buffer.from(requestPayload(r)), {key: keys.privateKey, dsaEncoding: 'ieee-p1363'}).toString('base64url');
  const q = store.requestRefund(r, signature);
  store.state.purchases[purchase.id].receipt.paymentMode = 'testnet';
  store.state.purchases[purchase.id].payment = {value: 100000};
  return {store, q};
}

test('cloud app refuses empty imported state and preserves the exact merchant signing identity', async t => {
  const x = create(t);
  assert.throws(() => createVeyloApp({...x.options, requireExistingState: true}), /Imported application state/);
  assert.equal(fs.existsSync(path.join(x.dir, 'state.json')), false);
  const original = newState(), filename = path.join(x.dir, 'state.json');
  fs.writeFileSync(filename, JSON.stringify(original));
  const app = createVeyloApp({...x.options, requireExistingState: true});
  assert.equal(app.store.state.secret, original.secret);
  assert.deepEqual(app.store.state.publicKey, original.publicKey);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename)).publicKey, original.publicKey);
  assert.equal((await request(app, '/api/catalog')).status, 200);
});

test('owner and independent seller sessions survive app reconstruction while logout remains effective', async t => {
  const x = create(t), sessions = new Map(), accountSessions = new Map();
  let app = createVeyloApp({...x.options, sessions, accountSessions});
  const login = await request(app, '/api/seller/login', {code: 'test-access-code'});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  // A cold invocation reconstructs the maps from encrypted storage.
  app = createVeyloApp({...x.options, sessions: new Map(JSON.parse(JSON.stringify([...sessions]))), accountSessions});
  assert.equal((await request(app, '/api/seller/products', undefined, cookie)).status, 200);
  await request(app, '/api/seller/logout', {}, cookie);
  assert.equal((await request(app, '/api/seller/products', undefined, cookie)).status, 401);
  const registration = await request(app, '/api/store-account/register', {username: 'cloud_seller', name: 'Cloud seller', password: 'a private long password'});
  const sellerCookie = registration.headers.get('set-cookie')[0].split(';')[0];
  app = createVeyloApp({...x.options, accountSessions: new Map(JSON.parse(JSON.stringify([...accountSessions])))});
  assert.equal((await request(app, '/api/store-account', undefined, sellerCookie)).json().username, 'cloud_seller');
  await request(app, '/api/store-account/logout', {}, sellerCookie);
  assert.equal((await request(app, '/api/store-account', undefined, sellerCookie)).status, 401);
});

test('parsed cloud request bodies obey size and origin checks; extension routes retain seller authorization', async t => {
  let extensionCalls = 0;
  const x = create(t, {route: async ({route, res, sellerActor, req}) => {
    if (route !== '/api/cloud-test') return false;
    extensionCalls++;
    res.writeHead(sellerActor(req) ? 200 : 401, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: Boolean(sellerActor(req))}));
    return true;
  }});
  const app = createVeyloApp(x.options);
  assert.equal((await request(app, '/api/seller/login', {}, '', {body: {code: 'test-access-code'}})).status, 200);
  assert.match((await request(app, '/api/seller/login', {}, '', {body: {code: 'x'.repeat(17000)}})).json().error, /too large/);
  assert.equal((await request(app, '/api/cloud-test', {})).status, 401);
  assert.equal(extensionCalls, 1);
  const hostile = await request(app, '/api/cloud-test', {}, '', {headers: {host: '127.0.0.1:3002', origin: 'https://attacker.example', 'content-type': 'application/json'}});
  assert.equal(hostile.status, 403);
  assert.equal(extensionCalls, 1);
});

test('no refund can spend before durable storage acknowledges its exact intent', async () => {
  const {store, q} = refund();
  let release, ready, sends = 0;
  const waiting = new Promise(r => ready = r);
  store.flush = async () => {assert.equal(q.status, 'sending'); assert.equal(q.memo, 'veylo:refund:' + q.id); ready(); await new Promise(r => release = r);};
  const wallet = {exclusive: f => f(), snapshot: async () => ({}), send: async () => {sends++; return 'a'.repeat(64);}};
  const pending = new Payments(store, wallet).refund(q.id);
  await waiting;
  assert.equal(sends, 0);
  release();
  assert.equal((await pending).status, 'broadcast');
  assert.equal(sends, 1);
  await assert.rejects(new Payments(store, wallet).refund(q.id), /already attempted/);
});

test('a storage failure cannot send funds; an uncertain wallet result is never retried', async () => {
  const {store, q} = refund();
  let sends = 0;
  const wallet = {exclusive: f => f(), snapshot: async () => ({}), send: async () => {sends++; throw Error('network response lost');}};
  store.flush = async () => {throw Error('storage unavailable');};
  await assert.rejects(new Payments(store, wallet).refund(q.id), /storage unavailable/);
  assert.equal(sends, 0);
  assert.equal(q.status, 'sending');
  // A separate request which has not been attempted exercises uncertain broadcast handling.
  const next = refund();
  next.store.flush = async () => {};
  const payments = new Payments(next.store, wallet);
  await assert.rejects(payments.refund(next.q.id), /No automatic retry/);
  assert.equal(next.q.status, 'unknown');
  await assert.rejects(payments.refund(next.q.id), /already attempted/);
  assert.equal(sends, 1);
});

test('queued independent-seller refunds remain pending without an invented transaction ID', async () => {
  const {store, q} = refund();
  let sends = 0, checkpoints = 0;
  store.flush = async () => {checkpoints++;};
  const wallet = {exclusive: f => f(), snapshot: async () => ({}), send: async () => {sends++;},
    deferRefund: async request => {assert.equal(checkpoints, 1); request.connectorJob = 'pending-job'; store.persist(); return request;}};
  const result = await new Payments(store, wallet).refund(q.id);
  assert.equal(result.status, 'sending');
  assert.equal(result.txid, undefined);
  assert.equal(sends, 0);
});
