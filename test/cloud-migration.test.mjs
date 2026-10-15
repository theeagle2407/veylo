import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync, randomBytes} from 'node:crypto';
import {createClient} from '@libsql/client';
import {CloudVault} from '../cloud-state.mjs';
import {Store} from '../core.mjs';
import {createEntryHandler} from '../api/index.mjs';
import {backupSqlite, capturePreview, importPreview, validateState, validateProject, assertPrivatePaths, previewRuntimeKey, redact} from '../scripts/cloud-migration.mjs';

const ACCOUNT = '6be4ea81-7f3a-44ee-9801-312ec18976e3';
function folder(t) {const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veylo-import-test-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir;}
function client(t, file) {const c = createClient({url: 'file:' + file}); t.after(() => c.close()); return c;}
async function sample(t) {
  const root = folder(t), wallet = path.join(root, 'local-wallet'), data = path.join(root, 'data');
  fs.mkdirSync(wallet); fs.mkdirSync(data);
  const store = new Store(), keys = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const p = store.createPurchase(keys.publicKey.export({format: 'jwk'})); store.simulatePayment(p.id);
  const original = Buffer.from(JSON.stringify(store.state)); fs.writeFileSync(path.join(data, 'state.json'), original);
  fs.writeFileSync(path.join(wallet, 'keys.toml'), 'network = "test"\nbirthday = 4465026\n');
  fs.mkdirSync(path.join(wallet, 'blocks')); fs.writeFileSync(path.join(wallet, 'blocks', '4500000-abcdef-compactblock'), 'fixture compact block');
  fs.writeFileSync(path.join(root, 'seller.age'), 'test-only identity fixture; not a real wallet key');
  for (const name of ['data.sqlite', 'blockmeta.sqlite']) {const c = client(t, path.join(wallet, name)); await c.execute('CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT)'); await c.execute("INSERT INTO fixture(value) VALUES ('private test fixture')");}
  const settings = {wallet, data, binary: '/not-executed-in-this-unit-test', VEYLO_SELLER_ACCOUNT: ACCOUNT, VEYLO_SELLER_IDENTITY: path.join(root, 'seller.age')};
  return {root, settings, store, original};
}

test('SQLite online backup includes committed WAL changes without changing the source database', async t => {
  const root = folder(t), source = path.join(root, 'source.sqlite'), dest = path.join(root, 'copy.sqlite');
  const db = client(t, source); await db.execute('PRAGMA journal_mode=WAL'); await db.execute('PRAGMA wal_autocheckpoint=0');
  await db.execute('CREATE TABLE fixture(value TEXT)'); await db.execute("INSERT INTO fixture VALUES ('latest committed WAL value')");
  const original = fs.readFileSync(source), wal = fs.readFileSync(source + '-wal');
  await backupSqlite(source, dest);
  assert.deepEqual(fs.readFileSync(source), original); assert.deepEqual(fs.readFileSync(source + '-wal'), wal);
  const copy = client(t, dest); assert.equal((await copy.execute('SELECT value FROM fixture')).rows[0].value, 'latest committed WAL value');
});

test('Preview capture preserves receipt bytes and merchant identity while excluding the signing identity', async t => {
  const f = await sample(t), snap = await capturePreview(f.root, {settings: f.settings, checkWallet: false});
  assert.equal(snap.summary.purchases, 1); assert.equal(snap.summary.signedReceipts, 1);
  assert.deepEqual(snap.files.get('data/state.json'), f.original); assert.equal(snap.files.has('identity.txt'), false);
  const config = JSON.parse(snap.files.get('config.json')); assert.equal(config.active, false); assert.equal(config.account, ACCOUNT);
  assert.deepEqual(fs.readFileSync(path.join(f.settings.data, 'state.json')), f.original);
  const restored = new Store(JSON.parse(snap.files.get('data/state.json'))); assert.equal(restored.validateReceipt(Object.values(f.store.state.purchases)[0].receipt), true);
  const db = client(t, path.join(snap.directory, 'wallet/data.sqlite')); assert.equal((await db.execute('SELECT value FROM fixture')).rows[0].value, 'private test fixture');
});

test('invalid existing receipts and corrupted product files stop the migration', async t => {
  const f = await sample(t), broken = structuredClone(f.store.state);
  Object.values(broken.purchases)[0].receipt.amount = '999';
  assert.throws(() => validateState(broken, path.join(f.settings.data, 'assets')), /receipt failed signature/);
  const state = structuredClone(f.store.state), hash = 'a'.repeat(64);
  state.merchantCatalog = {items: {fixture: {delivery: {schema: 'veylo.delivery.v1', sha256: hash, bytes: 3, name: 'fixture.txt'}}}};
  fs.mkdirSync(path.join(f.settings.data, 'assets')); fs.writeFileSync(path.join(f.settings.data, 'assets', hash), 'bad');
  assert.throws(() => validateState(state, path.join(f.settings.data, 'assets')), /fingerprint/);
});

test('a mainnet wallet is rejected before any Preview or operator configuration is created', async t => {
  const f = await sample(t); fs.writeFileSync(path.join(f.settings.wallet, 'keys.toml'), 'network = "main"\n');
  await assert.rejects(capturePreview(f.root, {settings: f.settings, checkWallet: false}), /Only.*testnet wallet/);
  assert.equal(fs.existsSync(path.join(f.root, '.veylo-cloud/operator.json')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.settings.data, 'state.json')), f.original);
});

test('Preview import refuses production scope and wallet identities; a new client reads the exact encrypted clone', async t => {
  const f = await sample(t), snap = await capturePreview(f.root, {settings: f.settings, checkWallet: false});
  const file = path.join(f.root, 'cloud.sqlite'), key = randomBytes(32).toString('hex');
  const production = new CloudVault(client(t, file), key, {scope: 'main'});
  await assert.rejects(importPreview(production, snap.files), /only import.*Preview/);
  const preview = new CloudVault(client(t, file), key, {scope: 'preview'});
  await assert.rejects(importPreview(preview, new Map([...snap.files, ['identity.txt', Buffer.from('fixture')]])), /identity-free Preview/);
  await importPreview(preview, snap.files);
  const cold = new CloudVault(client(t, file), key, {scope: 'preview'}), lease = await cold.acquire();
  try {const restored = await cold.readFiles(lease); for (const [name, bytes] of snap.files) assert.deepEqual(restored.get(name), bytes);} finally {await cold.release(lease);}
  assert.equal((await preview.client.execute("SELECT COUNT(*) AS n FROM veylo_cloud_root_v1 WHERE scope='main'")).rows[0].n, 0);
});

test('an existing Preview belonging to another merchant is preserved', async t => {
  const f = await sample(t), snap = await capturePreview(f.root, {settings: f.settings, checkWallet: false});
  const key = randomBytes(32).toString('hex'), vault = new CloudVault(client(t, path.join(f.root, 'cloud.sqlite')), key, {scope: 'preview'});
  const old = new Store().state, original = Buffer.from(JSON.stringify(old)); const lease = await vault.acquire();
  await vault.checkpoint(lease, {'data/state.json': original}); await vault.release(lease);
  await assert.rejects(importPreview(vault, snap.files), /another merchant/);
  const current = await vault.acquire(); try {assert.deepEqual((await vault.readFiles(current)).get('data/state.json'), original);} finally {await vault.release(current);}
});

test('Vercel configuration refuses another project, account or production branch', () => {
  const link = {projectId: 'prj_fixture', orgId: 'team_fixture'}, valid = {id: 'prj_fixture', accountId: 'team_fixture', name: 'veylo', link: {type: 'github', org: 'theeagle2407', repo: 'veylo', productionBranch: 'main'}};
  assert.equal(validateProject(link, valid).name, 'veylo');
  for (const changed of [{id: 'prj_other'}, {accountId: 'team_other'}, {name: 'other'}, {link: {productionBranch: 'veylo-cloud-migration'}}]) assert.throws(() => validateProject(link, {...valid, ...changed}));
});

test('the Preview encryption key cannot decrypt production data', async t => {
  const root = folder(t), file = path.join(root, 'separate-keys.sqlite'), master = randomBytes(32).toString('hex'), preview = previewRuntimeKey(master);
  assert.notEqual(master, preview); assert.equal(previewRuntimeKey(master), preview);
  const production = new CloudVault(client(t, file), master, {scope: 'main'}), lease = await production.acquire();
  await production.checkpoint(lease, {'data/state.json': Buffer.from('production fixture')}); await production.release(lease);
  const untrusted = new CloudVault(client(t, file), preview, {scope: 'main'});
  await assert.rejects(untrusted.acquire(), {code: 'VEYLO_CLOUD_INTEGRITY'});
  const current = await production.acquire(); try {assert.equal((await production.readFiles(current)).get('data/state.json').toString(), 'production fixture');} finally {await production.release(current);}
});

function response() {
  const headers = new Map();
  return {statusCode: 200, headers, headersSent: false, body: Buffer.alloc(0),
    setHeader(k, v) {assert.equal(this.headersSent, false); headers.set(k.toLowerCase(), v);},
    writeHead(code, h = {}) {this.statusCode = code; for (const [k, v] of Object.entries(h)) this.setHeader(k, v); this.headersSent = true;},
    end(bytes = '') {this.body = Buffer.from(bytes); this.headersSent = true;},
  };
}
test('browser wallet check resumes one read-only operation and normalizes unrelated Vercel cookies', async () => {
  const seen = [], entry = createEntryHandler({env: {}, runtime: async (req, res) => {seen.push(structuredClone({method: req.method, url: req.url, headers: req.headers, body: req.body})); res.statusCode = 202; res.end(JSON.stringify({pending: true}));}});
  const start = response(); await entry({method: 'GET', url: '/api/cloud/wallet-check', headers: {host: 'veylo-steel.vercel.app'}}, start);
  assert.equal(start.statusCode, 303); const location = start.headers.get('location');
  const pending = response(); await entry({method: 'GET', url: location, headers: {host: 'veylo-steel.vercel.app', cookie: 'toolbar=changed; veylo=abcdef; vercel-auth=rotating'}}, pending);
  assert.equal(seen[0].method, 'POST'); assert.equal(seen[0].url, '/api/cloud/wallet-check'); assert.deepEqual(seen[0].body, {});
  assert.equal(seen[0].headers.cookie, 'veylo=abcdef'); assert.equal(seen[0].headers.origin, 'https://veylo-steel.vercel.app');
  assert.equal(pending.headers.get('refresh'), '2; url=' + location);
  const other = response(); await entry({method: 'GET', url: '/api/seller/send-refund', headers: {host: 'veylo-steel.vercel.app'}}, other);
  assert.equal(seen[1].method, 'GET');
});

test('entrypoint rejects foreign hosts and does not modify sent headers on an unavailable diagnostic', async () => {
  let calls = 0;
  const entry = createEntryHandler({env: {}, runtime: async (_req, res) => {calls++; res.writeHead(503, {'Content-Type': 'application/json'}); res.end(JSON.stringify({code: 'VEYLO_CLOUD_BUSY'}));}});
  const denied = response(); await entry({method: 'GET', url: '/', headers: {host: 'attacker.example'}}, denied); assert.equal(denied.statusCode, 403); assert.equal(calls, 0);
  const res = response(); await entry({method: 'GET', url: '/api/cloud/wallet-check?op=11111111-1111-1111-1111-111111111111', headers: {host: 'veylo-steel.vercel.app'}}, res); assert.equal(res.statusCode, 503);
});

test('credential redaction and Git guards prevent private values from becoming publishable files', t => {
  const root = folder(t);
  execFileSync('git', ['init', '--quiet', '--initial-branch=veylo-cloud-migration'], {cwd: root});
  fs.writeFileSync(path.join(root, '.gitignore'), '.env*\n.veylo-cloud/\n.vercel/\ndata/\n*.age\n');
  fs.writeFileSync(path.join(root, '.env.cloud'), 'fixture only, no real credentials'); assert.doesNotThrow(() => assertPrivatePaths(root));
  execFileSync('git', ['add', '-f', '.env.cloud'], {cwd: root}); assert.throws(() => assertPrivatePaths(root), /private-file pattern/);
  const secret = 'fixture-database-auth-token', key = 'a'.repeat(64);
  const message = redact(secret + ' ' + key + ' eyJhbGci.fixture.signature AGE-SECRET-KEY-1ABCDEF', [secret, key]);
  assert.equal(message.includes(secret), false); assert.equal(message.includes(key), false); assert.equal(message.includes('AGE-SECRET-KEY-1ABCDEF'), false);
});
