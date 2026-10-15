import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes, randomUUID, generateKeyPairSync} from 'node:crypto';
import {createClient} from '@libsql/client';
import {CloudVault} from '../cloud-state.mjs';
import {Store} from '../core.mjs';
import {stagedRequest, deploymentView, previewProof, ageIdentity, accountIndex, captureProduction, importProduction, activateProduction, parseCurl, migrationClient, readSelectedMetadata, vercelArguments, savedProductionCheck, cutoverFailureDetails, publicCloudHealth} from '../scripts/cloud-cutover.mjs';

const ACCOUNT = '6be4ea81-7f3a-44ee-9801-312ec18976e3';
// Deliberately invalid checksum: a format-only test fixture, never a real identity.
const IDENTITY = Buffer.from('# public test fixture, no wallet secret\nAGE-SECRET-KEY-1' + 'A'.repeat(58) + '\n');
function folder(t) {const p = fs.mkdtempSync(path.join(os.tmpdir(), 'veylo-cutover-test-')); t.after(() => fs.rmSync(p, {recursive: true, force: true})); return p;}
function client(t, file) {const c = createClient({url: 'file:' + file}); t.after(() => c.close()); return c;}
function files() {
  const store = new Store(), keys = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const p = store.createPurchase(keys.publicKey.export({format: 'jwk'})); store.simulatePayment(p.id);
  return new Map([
    ['data/state.json', Buffer.from(JSON.stringify(store.state))],
    ['wallet/keys.toml', Buffer.from('network = "test"\n')],
    ['identity.txt', IDENTITY],
    ['config.json', Buffer.from(JSON.stringify({schema: 1, paymentMode: 'testnet', account: ACCOUNT, sellerCode: 'test-only-private-operator-code', active: false}))],
  ]);
}
async function read(vault) {const l = await vault.acquire(); try {return await vault.readFiles(l);} finally {await vault.release(l);}}
async function mutate(vault, fn) {const l = await vault.acquire(); try {const f = await vault.readFiles(l); await fn(f); await vault.checkpoint(l, f);} finally {await vault.release(l);}}

test('production request pins the Git commit and disables automatic domain assignment', () => {
  const sha = 'a'.repeat(40), req = stagedRequest('prj_fixture', 12345, sha, randomUUID());
  assert.equal(req.autoAssignCustomDomains, false); assert.equal(req.target, 'production');
  assert.equal(req.gitSource.sha, sha); assert.equal(req.gitSource.ref, 'veylo-cloud-migration');
  assert.equal('files' in req, false); assert.equal('env' in req, false); assert.equal('buildMachine' in req, false);
  assert.throws(() => stagedRequest('other', 12345, sha, randomUUID()));
});
test('protected deployment curl preserves HTTP arguments without forwarding unsupported CLI globals', () => {
  const root = '/project with spaces', deployment = 'https://veylo-fixture.vercel.app';
  const http = ['--silent', '--show-error', '--request', 'POST', '--data-binary', '@/private folder/request.json', '--cookie-jar', '/private folder/cookies.txt', '--write-out', '\nVEYLO_STATUS:%{http_code}\n'];
  const args = vercelArguments(root, ['curl', '/api/seller/login', '--deployment', deployment], http);
  assert.equal(args.includes('--cwd'), false); assert.equal(args.includes('--no-color'), false);
  assert.equal(args[args.indexOf('--deployment') + 1], deployment);
  assert.equal(args.includes('/api/seller/login'), true);
  assert.equal(args[args.indexOf('--scope') + 1], 'theeagle2407s-projects');
  assert.deepEqual(args.slice(args.indexOf('--') + 1), http);
  const ordinary = vercelArguments(root, ['api', '/v9/projects/prj_fixture', '--method', 'GET', '--raw']);
  assert.equal(ordinary[ordinary.indexOf('--cwd') + 1], root);
  assert.equal(ordinary.includes('--no-color'), true);
});
test('deployment guards reject foreign projects, nonproduction builds and mismatched source', () => {
  const good = {id: 'dpl_fixture', url: 'veylo-fixture.vercel.app', projectId: 'prj_fixture', target: 'production', readyState: 'READY', gitSource: {sha: 'a'.repeat(40)}};
  assert.equal(deploymentView(good, 'prj_fixture', 'a'.repeat(40)).url, 'https://veylo-fixture.vercel.app');
  for (const change of [{projectId: 'prj_other'}, {target: null}, {url: 'attacker.example'}, {gitSource: {sha: 'b'.repeat(40)}}]) assert.throws(() => deploymentView({...good, ...change}, 'prj_fixture', 'a'.repeat(40)));
  assert.equal(deploymentView({...good, readyState: 'BUILDING', gitSource: {}}, 'prj_fixture', 'a'.repeat(40)).readyState, 'BUILDING');
});
test('production requires the recent actual Preview check and identity-free testnet data', () => {
  const f = files(); f.delete('identity.txt');
  const proof = {ok: true, checkedAt: new Date().toISOString(), chainHeight: 4505665, walletTransactions: 15, cloudRecoveryVerified: true, transactionsSent: 0};
  f.set('runtime.json', Buffer.from(JSON.stringify({operations: {fixture: {response: {status: 200, base64: Buffer.from(JSON.stringify(proof)).toString('base64')}}}})));
  assert.equal(previewProof(f).check.walletTransactions, 15);
  assert.throws(() => previewProof(f, Date.now() + 90000000), /Complete.*Preview/);
  f.set('identity.txt', IDENTITY); assert.throws(() => previewProof(f), /no signing identity/);
});
test('identity validation rejects plugin references and account derivation selects the configured account', () => {
  assert.deepEqual(ageIdentity(IDENTITY), IDENTITY);
  assert.throws(() => ageIdentity(Buffer.from('AGE-PLUGIN-HARDWARE-1fixture')));
  const text = 'Account 00000000-0000-0000-0000-000000000000 (birthday height 1)\n       Account index: 99\nAccount ' + ACCOUNT + ' (birthday height 4465026)\n     Source: derived\n       Account index: 2\n';
  assert.equal(accountIndex(text, ACCOUNT), 2); assert.throws(() => accountIndex(text, 'missing'));
});
test('production capture preserves the merchant, receipt and original identity while copying SQLite safely', async t => {
  const root = folder(t), wallet = path.join(root, 'original-wallet'), data = path.join(root, 'data'); fs.mkdirSync(wallet); fs.mkdirSync(data);
  const f = files(); fs.writeFileSync(path.join(data, 'state.json'), f.get('data/state.json')); fs.writeFileSync(path.join(wallet, 'keys.toml'), f.get('wallet/keys.toml'));
  const identity = path.join(root, 'original.age'); fs.writeFileSync(identity, IDENTITY);
  for (const name of ['data.sqlite', 'blockmeta.sqlite']) {const c = client(t, path.join(wallet, name)); await c.execute('CREATE TABLE fixture(value TEXT)'); await c.execute("INSERT INTO fixture VALUES ('original data')");}
  const snap = await captureProduction(root, {settings: {wallet, data, binary: '/not-executed', VEYLO_SELLER_ACCOUNT: ACCOUNT, VEYLO_SELLER_IDENTITY: identity}, checkWallet: false});
  assert.deepEqual(snap.files.get('identity.txt'), IDENTITY); assert.deepEqual(fs.readFileSync(identity), IDENTITY);
  assert.deepEqual(snap.files.get('data/state.json'), f.get('data/state.json')); assert.equal(JSON.parse(snap.files.get('config.json')).active, false);
  const store = new Store(JSON.parse(snap.files.get('data/state.json'))); assert.ok(store.validateReceipt(Object.values(store.state.purchases)[0].receipt));
});
test('production import is inactive and an ambiguous retry preserves all newer cloud records', async t => {
  const root = folder(t), file = path.join(root, 'cloud.sqlite'), key = randomBytes(32).toString('hex');
  const vault = () => new CloudVault(client(t, file), key, {scope: 'main'}), original = files(), id = randomUUID(), issuer = JSON.parse(original.get('data/state.json')).publicKey.x;
  const first = await importProduction(vault(), original, {id, issuer}); assert.equal(first.account, ACCOUNT);
  const initial = await read(vault()); assert.equal(JSON.parse(initial.get('config.json')).active, false);
  await mutate(vault(), f => {const state = JSON.parse(f.get('data/state.json')); state.notices.push({id: 'new-cloud-record'}); f.set('data/state.json', Buffer.from(JSON.stringify(state)));});
  const before = (await read(vault())).get('data/state.json');
  const retry = await importProduction(vault(), original, {id, issuer}); assert.equal(retry.resumed, true);
  assert.deepEqual((await read(vault())).get('data/state.json'), before);
  await assert.rejects(importProduction(vault(), original, {id: randomUUID(), issuer}), /different data/);
  await assert.rejects(importProduction(new CloudVault(client(t, file), key, {scope: 'preview'}), original, {id, issuer}), /main storage/);
});
test('activation changes only the matching configuration and preserves purchases and wallet files across clients', async t => {
  const root = folder(t), file = path.join(root, 'cloud.sqlite'), key = randomBytes(32).toString('hex'), f = files(), id = randomUUID();
  const vault = () => new CloudVault(client(t, file), key, {scope: 'main'});
  const imported = await importProduction(vault(), f, {id, issuer: JSON.parse(f.get('data/state.json')).publicKey.x}), plan = {id, imported};
  const before = await read(vault());
  await assert.rejects(activateProduction(vault(), {...plan, id: randomUUID()}), /does not match/);
  await activateProduction(vault(), plan); const after = await read(vault());
  assert.equal(JSON.parse(after.get('config.json')).active, true);
  for (const [name, bytes] of before) if (name !== 'config.json') assert.deepEqual(after.get(name), bytes);
  assert.equal((await activateProduction(vault(), plan)).alreadyActive, true);
  await mutate(vault(), x => x.set('identity.txt', Buffer.from(IDENTITY.toString().replace('A', 'B'))));
  await assert.rejects(activateProduction(vault(), plan), /does not match/);
});
test('protected HTTP parsing distinguishes pending progress from completion and refuses sign-in HTML', () => {
  assert.deepEqual(parseCurl('{"pending":true}\nVEYLO_STATUS:202\n'), {status: 202, data: {pending: true}});
  assert.deepEqual(parseCurl('{"ok":true}\nVEYLO_STATUS:200\n'), {status: 200, data: {ok: true}});
  assert.throws(() => parseCurl('<html>Sign in</html>\nVEYLO_STATUS:401\n'), /non-JSON.*401/);
  assert.throws(() => parseCurl('{"ok":true}'), /HTTP status/);
});

async function metadataSample(t, {identity = false} = {}) {
  const root = folder(t), c = client(t, path.join(root, 'metadata.sqlite')), key = randomBytes(32).toString('hex');
  const input = files();
  if (!identity) input.delete('identity.txt');
  const state = JSON.parse(input.get('data/state.json')); state.testPadding = 'p'.repeat(150000); input.set('data/state.json', Buffer.from(JSON.stringify(state)));
  const proof = {ok: true, checkedAt: new Date().toISOString(), chainHeight: 4505665, walletTransactions: 15, cloudRecoveryVerified: true, transactionsSent: 0};
  input.set('runtime.json', Buffer.from(JSON.stringify({schema: 1, operations: {fixture: {response: {status: 200, base64: Buffer.from(JSON.stringify(proof)).toString('base64')}}}})));
  input.set('wallet/data.sqlite', randomBytes(1048576));
  const vault = new CloudVault(c, key, {scope: 'preview'}), lease = await vault.acquire();
  await vault.checkpoint(lease, input); const manifest = structuredClone(lease.manifest); await vault.release(lease);
  return {c, key, input, manifest};
}

test('metadata-only reads authenticate the saved proof without wallet downloads, DDL or lease updates', async t => {
  const f = await metadataSample(t), before = await f.c.execute("SELECT owner, fence, revision, lease_until FROM veylo_cloud_root_v1 WHERE scope='preview'");
  const queries = [], readonly = {async execute(stmt) {
    assert.match(stmt.sql, /^SELECT /); queries.push(stmt);
    return f.c.execute(stmt);
  }};
  const result = await readSelectedMetadata(readonly, f.key);
  assert.equal(result.files.size, 3); assert.equal(result.files.has('wallet/data.sqlite'), false);
  assert.equal(previewProof(result.files).check.walletTransactions, 15);
  for (const [name, value] of result.files) assert.deepEqual(value, f.input.get(name));
  const walletIds = f.manifest.files.find(x => x.name === 'wallet/data.sqlite').chunks;
  for (const q of queries.slice(1)) {assert.ok(q.args.length <= 3); assert.ok(q.args.slice(1).every(id => !walletIds.includes(id)));}
  assert.deepEqual((await f.c.execute("SELECT owner, fence, revision, lease_until FROM veylo_cloud_root_v1 WHERE scope='preview'")).rows, before.rows);
});

test('metadata-only reads reject the wrong key and corruption in a selected encrypted chunk', async t => {
  const f = await metadataSample(t);
  await assert.rejects(readSelectedMetadata(f.c, randomBytes(32).toString('hex')), {code: 'VEYLO_CLOUD_INTEGRITY'});
  const id = f.manifest.files.find(x => x.name === 'runtime.json').chunks[0];
  await f.c.execute({sql: 'UPDATE veylo_cloud_chunks_v1 SET payload=? WHERE scope=? AND id=?', args: [randomBytes(80), 'preview', id]});
  await assert.rejects(readSelectedMetadata(f.c, f.key), {code: 'VEYLO_CLOUD_INTEGRITY'});
});

test('metadata-only reads check the authenticated manifest for a forbidden Preview identity', async t => {
  const f = await metadataSample(t, {identity: true});
  await assert.rejects(readSelectedMetadata(f.c, f.key), /Preview must not contain a signing identity/);
  await assert.rejects(readSelectedMetadata(f.c, f.key, {names: ['wallet/data.sqlite']}), /Invalid migration metadata/);
});

test('metadata-only reads report unavailable chunks without replacing the snapshot', async t => {
  const f = await metadataSample(t), before = await f.c.execute("SELECT revision, manifest FROM veylo_cloud_root_v1 WHERE scope='preview'");
  const id = f.manifest.files.find(x => x.name === 'runtime.json').chunks[0];
  await f.c.execute({sql: 'DELETE FROM veylo_cloud_chunks_v1 WHERE scope=? AND id=?', args: ['preview', id]});
  await assert.rejects(readSelectedMetadata(f.c, f.key), /chunk is no longer available/);
  assert.deepEqual((await f.c.execute("SELECT revision, manifest FROM veylo_cloud_root_v1 WHERE scope='preview'")).rows, before.rows);
});

test('migration client deadline is 45 seconds and failed requests are not automatically replayed', async t => {
  const timeouts = []; let requests = 0;
  t.mock.method(AbortSignal, 'timeout', ms => {timeouts.push(ms); return new AbortController().signal;});
  t.mock.method(globalThis, 'fetch', async request => {requests++; assert.equal(request.method, 'POST'); throw Error('synthetic migration network failure');});
  const c = migrationClient({TURSO_DATABASE_URL: 'libsql://fixture.turso.io', TURSO_AUTH_TOKEN: 'test-only-no-credentials'});
  try {await assert.rejects(c.execute('SELECT 1'), /synthetic migration network failure/);} finally {c.close();}
  assert.equal(requests, 1); assert.deepEqual(timeouts, [45000]);
});

const syntheticNetworkFailure = () => Object.assign(new TypeError('fetch failed'), {cause: Object.assign(Error('synthetic connection reset'), {code: 'ECONNRESET'})});
const activationUpdate = statement => /^UPDATE veylo_cloud_root_v1 SET manifest/.test(statement.sql);
const activationInsert = statement => /^INSERT INTO veylo_cloud_chunks_v1/.test(statement.sql);
async function activationFixture(t) {
  const root = folder(t), c = client(t, path.join(root, 'activation.sqlite')), key = randomBytes(32).toString('hex');
  const original = files(); original.set('wallet/data.sqlite', randomBytes(1048576));
  const vault = transport => new CloudVault(transport || c, key, {scope: 'main'});
  const id = randomUUID(), issuer = JSON.parse(original.get('data/state.json')).publicKey.x;
  const imported = await importProduction(vault(), original, {id, issuer});
  return {c, key, vault, original, plan: {id, imported}};
}
test('configuration-only activation preserves every other manifest entry and never fetches wallet chunks or acquires a lease', async t => {
  const f = await activationFixture(t), before = await readSelectedMetadata(f.c, f.key, {scope: 'main', names: ['config.json', 'data/state.json', 'identity.txt']});
  const walletIds = before.manifest.files.find(x => x.name === 'wallet/data.sqlite').chunks, queries = [];
  const transport = {async execute(statement) {queries.push(statement); assert.match(statement.sql, /^(SELECT|INSERT INTO veylo_cloud_chunks_v1|UPDATE veylo_cloud_root_v1 SET manifest)/); return f.c.execute(statement);}};
  const result = await activateProduction(f.vault(transport), f.plan); assert.equal(result.configOnly, true);
  for (const q of queries) assert.ok(!(q.args || []).some(value => walletIds.includes(value)));
  const after = await readSelectedMetadata(f.c, f.key, {scope: 'main', names: ['config.json', 'data/state.json', 'identity.txt']});
  assert.deepEqual(after.manifest.files.filter(x => x.name !== 'config.json'), before.manifest.files.filter(x => x.name !== 'config.json'));
  assert.equal(JSON.parse(after.files.get('config.json')).active, true);
  assert.deepEqual((await read(f.vault())).get('wallet/data.sqlite'), f.original.get('wallet/data.sqlite'));
});
test('cold metadata recovery retries a dropped read without issuing any writes', async t => {
  const f = await activationFixture(t); let requests = 0;
  const transport = {async execute(statement) {assert.match(statement.sql, /^SELECT/); if (++requests === 1) throw syntheticNetworkFailure(); return f.c.execute(statement);}};
  const result = await readSelectedMetadata(transport, f.key, {scope: 'main', names: ['config.json', 'data/state.json', 'identity.txt']});
  assert.equal(result.files.size, 3); assert.equal(JSON.parse(result.files.get('config.json')).active, false);
});
test('activation reconciles a connection failure after commit without replaying the manifest update', async t => {
  const f = await activationFixture(t); let writes = 0;
  const transport = {async execute(statement) {const result = await f.c.execute(statement); if (activationUpdate(statement) && ++writes === 1) throw syntheticNetworkFailure(); return result;}};
  const result = await activateProduction(f.vault(transport), f.plan);
  assert.equal(result.recovered, true); assert.equal(writes, 1);
  assert.equal((await activateProduction(f.vault(transport), f.plan)).alreadyActive, true); assert.equal(writes, 1);
});
test('activation verifies an uncommitted connection failure before another conditional update', async t => {
  const f = await activationFixture(t); let writes = 0;
  const transport = {async execute(statement) {if (activationUpdate(statement) && ++writes === 1) throw syntheticNetworkFailure(); return f.c.execute(statement);}};
  assert.equal((await activateProduction(f.vault(transport), f.plan)).configOnly, true); assert.equal(writes, 2);
});
test('activation authenticates the staged configuration after a lost INSERT response', async t => {
  const f = await activationFixture(t); let writes = 0;
  const transport = {async execute(statement) {const result = await f.c.execute(statement); if (activationInsert(statement) && ++writes === 1) throw syntheticNetworkFailure(); return result;}};
  assert.equal((await activateProduction(f.vault(transport), f.plan)).configOnly, true); assert.equal(writes, 1);
});
test('activation only repeats the immutable INSERT after reading that it did not commit', async t => {
  const f = await activationFixture(t); let writes = 0;
  const transport = {async execute(statement) {if (activationInsert(statement) && ++writes === 1) throw syntheticNetworkFailure(); return f.c.execute(statement);}};
  assert.equal((await activateProduction(f.vault(transport), f.plan)).configOnly, true); assert.equal(writes, 2);
});
test('activation refuses a live writer lease and can resume after the writer releases it', async t => {
  const f = await activationFixture(t), writer = f.vault(), lease = await writer.acquire();
  const before = (await f.c.execute("SELECT revision, manifest FROM veylo_cloud_root_v1 WHERE scope='main'")).rows;
  await assert.rejects(activateProduction(f.vault(), f.plan), {code: 'VEYLO_CLOUD_BUSY'});
  assert.deepEqual((await f.c.execute("SELECT revision, manifest FROM veylo_cloud_root_v1 WHERE scope='main'")).rows, before);
  await writer.release(lease); assert.equal((await activateProduction(f.vault(), f.plan)).configOnly, true);
});
test('activation preserves a concurrent purchase and wallet update instead of overwriting its manifest', async t => {
  const f = await activationFixture(t); let writes = 0; const newWallet = randomBytes(1048576);
  const transport = {async execute(statement) {
    if (activationUpdate(statement) && ++writes === 1) await mutate(f.vault(), current => {
      const state = JSON.parse(current.get('data/state.json')); state.notices.push({id: 'concurrent-record'});
      current.set('data/state.json', Buffer.from(JSON.stringify(state))); current.set('wallet/data.sqlite', newWallet);
    });
    return f.c.execute(statement);
  }};
  await activateProduction(f.vault(transport), f.plan); assert.equal(writes, 2);
  const after = await read(f.vault()); assert.deepEqual(after.get('wallet/data.sqlite'), newWallet);
  assert.equal(JSON.parse(after.get('data/state.json')).notices.at(-1).id, 'concurrent-record');
  assert.equal(JSON.parse(after.get('config.json')).active, true);
});
test('activation bounds read retries and exposes the failing step and network cause', async t => {
  const f = await activationFixture(t); let requests = 0;
  const transport = {async execute(statement) {requests++; assert.match(statement.sql, /^SELECT/); throw syntheticNetworkFailure();}};
  let observed;
  try {await activateProduction(f.vault(transport), f.plan);} catch (error) {observed = error;}
  assert.ok(observed); assert.equal(requests, 3);
  const details = cutoverFailureDetails(observed, 'activation');
  assert.equal(details.step, 'read activation manifest'); assert.equal(details.causes[0].code, 'ECONNRESET');
  assert.equal(JSON.parse((await read(f.vault())).get('config.json')).active, false);
});
test('an uncertain commit verification preserves state and a later resume recognizes completed activation', async t => {
  const f = await activationFixture(t); let committed = false, writes = 0;
  const transport = {async execute(statement) {
    if (committed && statement.sql.startsWith('SELECT')) throw syntheticNetworkFailure();
    const result = await f.c.execute(statement);
    if (activationUpdate(statement)) {writes++; committed = true; throw syntheticNetworkFailure();}
    return result;
  }};
  await assert.rejects(activateProduction(f.vault(transport), f.plan), {code: 'VEYLO_ACTIVATION_UNCERTAIN'});
  assert.equal(writes, 1); const revision = (await f.c.execute("SELECT revision FROM veylo_cloud_root_v1 WHERE scope='main'")).rows[0].revision;
  assert.equal((await activateProduction(f.vault(), f.plan)).alreadyActive, true);
  assert.equal((await f.c.execute("SELECT revision FROM veylo_cloud_root_v1 WHERE scope='main'")).rows[0].revision, revision);
  assert.deepEqual((await read(f.vault())).get('wallet/data.sqlite'), f.original.get('wallet/data.sqlite'));
});
test('saved production proof is reused only while recent, read-only and bound to the same deployment', () => {
  const now = Date.now(), p = {deployment: {id: 'dpl_fixture'}, productionCheck: {ok: true, checkedAt: new Date(now).toISOString(), chainHeight: 4505665, walletTransactions: 15, cloudRecoveryVerified: true, transactionsSent: 0}};
  assert.equal(savedProductionCheck(p, now), true); assert.equal(savedProductionCheck(p, now + 3600000), false);
  assert.equal(savedProductionCheck({...p, productionCheckedDeployment: 'dpl_other'}, now), false);
  assert.equal(savedProductionCheck({...p, productionCheck: {...p.productionCheck, transactionsSent: 1}}, now), false);
  assert.equal(savedProductionCheck({...p, productionCheck: {...p.productionCheck, cloudRecoveryVerified: false}}, now), false);
});
test('cutover error details retain network causes without revealing credentials, URLs or parsing input', () => {
  const token = 'private-test-token-do-not-print', key = 'b'.repeat(64);
  const error = syntheticNetworkFailure(); error.message += ' https://private.example/' + token + ' ' + key;
  const detail = JSON.stringify(cutoverFailureDetails(error, 'activation', [token, key]));
  assert.equal(detail.includes(token), false); assert.equal(detail.includes(key), false); assert.equal(detail.includes('private.example'), false); assert.match(detail, /ECONNRESET/);
  assert.equal(JSON.stringify(cutoverFailureDetails(new SyntaxError('private saved input'), 'parse')).includes('private saved input'), false);
});
test('public health checks retry only reads after a reset or transient gateway response', async () => {
  let requests = 0;
  const health = {ok: true, mode: 'live', storage: 'encrypted', network: 'Zcash testnet'};
  const result = await publicCloudHealth({fetcher: async (_url, options) => {
    assert.equal(options.redirect, 'manual'); requests++;
    if (requests === 1) throw syntheticNetworkFailure();
    if (requests === 2) return new Response('temporary gateway failure', {status: 502});
    return Response.json(health);
  }});
  assert.deepEqual(result, health); assert.equal(requests, 3);
});
test('public health rejects redirects, non-JSON responses and an inactive or unencrypted app', async () => {
  for (const response of [new Response('', {status: 302}), new Response('<html>sign in</html>'), Response.json({ok: true, mode: 'preview', storage: 'encrypted', network: 'Zcash testnet'}), Response.json({ok: true, mode: 'live', storage: 'local', network: 'Zcash testnet'})]) {
    await assert.rejects(publicCloudHealth({fetcher: async () => response}), /submitted URL/);
  }
});
