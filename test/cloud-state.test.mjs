import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createClient} from '@libsql/client';
import {CloudVault, CLOUD_CHUNK_BYTES, checkCloudStorage, cloudClient} from '../cloud-state.mjs';

async function database(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-cloud-test-'));
  const url = `file:${path.join(directory, 'store.sqlite')}`;
  const clients = [];
  const connect = () => {
    const client = createClient({url, timeout: 1000});
    clients.push(client);
    return client;
  };
  t.after(async () => {
    for (const client of clients) { try { client.close(); } catch {} }
    await fs.rm(directory, {recursive: true, force: true});
  });
  return {connect, key: randomBytes(32).toString('hex')};
}

test('encrypted files survive a new client and unchanged chunks are reused', async t => {
  const {connect, key} = await database(t);
  const client = connect();
  const first = new CloudVault(client, key);
  const lease = await first.acquire();
  const secret = Buffer.from('private merchant data must not appear as plaintext');
  const large = Buffer.concat([randomBytes(CLOUD_CHUNK_BYTES), randomBytes(100)]);
  const input = new Map([['data/state.json', secret], ['wallet/data.sqlite', large], ['wallet/empty', Buffer.alloc(0)]]);
  const saved = await first.checkpoint(lease, input);
  assert.equal(saved.newChunks, 3);
  const repeated = await first.checkpoint(lease, input);
  assert.equal(repeated.newChunks, 0);
  assert.equal(repeated.revision, saved.revision);
  assert.equal(repeated.unchanged, true);
  const row = (await client.execute("SELECT manifest FROM veylo_cloud_root_v1 WHERE scope = 'main'")).rows[0];
  assert.equal(Buffer.from(row.manifest).includes(Buffer.from('data/state.json')), false);
  const payloads = await client.execute('SELECT payload FROM veylo_cloud_chunks_v1');
  for (const value of payloads.rows) assert.equal(Buffer.from(value.payload).includes(secret), false);
  await first.release(lease);
  client.close();
  const second = new CloudVault(connect(), key);
  const secondLease = await second.acquire();
  const output = await second.readFiles(secondLease);
  assert.deepEqual([...output.keys()].sort(), [...input.keys()].sort());
  for (const [name, data] of input) assert.deepEqual(output.get(name), data);
  await second.release(secondLease);
});

test('a second writer is excluded and an expired writer cannot overwrite its successor', async t => {
  const {connect, key} = await database(t);
  const client = connect();
  const first = new CloudVault(client, key);
  const second = new CloudVault(connect(), key);
  const old = await first.acquire();
  await assert.rejects(second.acquire(), {code: 'VEYLO_CLOUD_BUSY'});
  await client.execute("UPDATE veylo_cloud_root_v1 SET lease_until = 0 WHERE scope = 'main'");
  const current = await second.acquire();
  assert.ok(current.fence > old.fence);
  await second.checkpoint(current, {'data/state.json': Buffer.from('new writer')});
  await assert.rejects(first.checkpoint(old, {'data/state.json': Buffer.from('stale writer')}), {code: 'VEYLO_CLOUD_LEASE_LOST'});
  await first.release(old);
  await assert.rejects(first.acquire(), {code: 'VEYLO_CLOUD_BUSY'});
  assert.equal((await second.readFiles(current)).get('data/state.json').toString(), 'new writer');
  await second.release(current);
});

test('wrong encryption keys and modified ciphertext fail without replacing saved data', async t => {
  const {connect, key} = await database(t);
  const client = connect();
  const vault = new CloudVault(client, key);
  const lease = await vault.acquire();
  await vault.checkpoint(lease, {'data/state.json': Buffer.from('preserved data')});
  await vault.release(lease);
  const wrong = new CloudVault(connect(), randomBytes(32).toString('hex'));
  await assert.rejects(wrong.acquire(), {code: 'VEYLO_CLOUD_INTEGRITY'});
  const reopened = new CloudVault(connect(), key);
  const valid = await reopened.acquire();
  assert.equal((await reopened.readFiles(valid)).get('data/state.json').toString(), 'preserved data');
  await reopened.release(valid);
  const stored = (await client.execute('SELECT id, payload FROM veylo_cloud_chunks_v1')).rows[0];
  const changed = Buffer.from(stored.payload);
  changed[changed.length - 1] ^= 1;
  await client.execute({sql: 'UPDATE veylo_cloud_chunks_v1 SET payload = ? WHERE id = ?', args: [changed, stored.id]});
  const cold = new CloudVault(connect(), key);
  const coldLease = await cold.acquire();
  await assert.rejects(cold.readFiles(coldLease), {code: 'VEYLO_CLOUD_INTEGRITY'});
  await cold.release(coldLease);
});

test('unsafe paths and blind snapshot replacement are rejected', async t => {
  const {connect, key} = await database(t);
  const vault = new CloudVault(connect(), key);
  const lease = await vault.acquire();
  for (const name of ['../state.json', '/tmp/state.json', 'wallet/../state.json', 'wallet//state.json']) {
    await assert.rejects(vault.checkpoint(lease, {[name]: Buffer.from('x')}), {code: 'VEYLO_CLOUD_INVALID'});
  }
  await vault.checkpoint(lease, {'data/state.json': Buffer.from('retain')});
  await vault.release(lease);
  const second = new CloudVault(connect(), key);
  const replacement = await second.acquire();
  await assert.rejects(second.checkpoint(replacement, {}), {code: 'VEYLO_CLOUD_INVALID'});
  await second.readFiles(replacement);
  await second.release(replacement);
});

test('the setup storage check uses a separate scope and removes its temporary records', async t => {
  const {connect, key} = await database(t);
  const client = connect();
  const vault = new CloudVault(client, key);
  const lease = await vault.acquire();
  await vault.checkpoint(lease, {'data/state.json': Buffer.from('application data stays intact')});
  await vault.release(lease);
  const checked = await checkCloudStorage(connect, key);
  assert.equal(checked.ok, true);
  assert.equal(checked.concurrentWriterExcluded, true);
  assert.equal(checked.persistedAcrossClients, true);
  assert.equal(checked.walletSecretsUsed, false);
  assert.equal((await client.execute("SELECT COUNT(*) AS n FROM veylo_cloud_root_v1 WHERE scope LIKE 'check-%'")).rows[0].n, 0);
  const again = new CloudVault(connect(), key);
  const reopened = await again.acquire();
  assert.equal((await again.readFiles(reopened)).get('data/state.json').toString(), 'application data stays intact');
  await again.release(reopened);
});

test('remote client requires an authenticated TLS Turso libSQL endpoint', () => {
  for (const url of ['http://example.com', 'libsql://example.com', 'https://x.turso.io/?token=secret', 'turso://x.turso.io']) {
    assert.throws(() => cloudClient({TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'token'}), {code: 'VEYLO_CLOUD_INVALID'});
  }
  const client = cloudClient({TURSO_DATABASE_URL: 'libsql://fixture.turso.io', TURSO_AUTH_TOKEN: 'token'});
  client.close();
});
