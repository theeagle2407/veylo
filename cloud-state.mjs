import {createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID} from 'node:crypto';
import {createClient} from '@libsql/client/web';

const NOW = '(unixepoch() * 1000)';
const ROOT = 'veylo_cloud_root_v1';
const CHUNKS = 'veylo_cloud_chunks_v1';
export const CLOUD_CHUNK_BYTES = 65536;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/;

export class CloudStorageError extends Error {
  constructor(code, message) { super(message); this.name = 'CloudStorageError'; this.code = code; }
}
const invalid = message => new CloudStorageError('VEYLO_CLOUD_INVALID', message);
const integrity = () => new CloudStorageError('VEYLO_CLOUD_INTEGRITY', 'Stored data could not be authenticated. Preserve the original encryption key and backup.');
const lost = () => new CloudStorageError('VEYLO_CLOUD_LEASE_LOST', 'Storage ownership expired. This request must stop.');
const busy = () => new CloudStorageError('VEYLO_CLOUD_BUSY', 'Another request is using the store. Retry shortly.');
const number = value => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw integrity();
  return result;
};
const bytes = value => {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw integrity();
};
function validName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]{1,240}$/.test(name) || name.startsWith('/') ||
      name.split('/').some(part => !part || part === '.' || part === '..')) throw invalid('Invalid snapshot file path.');
}

export function cloudClient(env = process.env) {
  let url;
  try { url = new URL(env.TURSO_DATABASE_URL || ''); } catch { throw invalid('Set the Turso libSQL database URL.'); }
  if (!['libsql:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.turso.io') ||
      url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw invalid('Use the libSQL database URL from Turso. A turso:// database uses a different engine.');
  }
  const token = env.TURSO_AUTH_TOKEN;
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) throw invalid('Set the Turso database authentication token.');
  // HTTPS is deliberate: no persistent WebSocket or local native database is needed in Vercel.
  return createClient({
    url: `https://${url.hostname}`,
    authToken: token,
    concurrency: 4,
    intMode: 'number',
    fetch: request => fetch(request, {signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)].filter(Boolean))}),
  });
}

export class CloudVault {
  constructor(client, keyHex, {scope = 'main', ttlMs = 60000, cache = new Map()} = {}) {
    if (!/^[a-f0-9]{64}$/i.test(keyHex || '')) throw invalid('VEYLO_CLOUD_KEY must be a 32-byte hexadecimal key.');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(scope)) throw invalid('Invalid storage scope.');
    if (!Number.isInteger(ttlMs) || ttlMs < 5000 || ttlMs > 300000) throw invalid('Invalid storage lease duration.');
    this.client = client;
    this.scope = scope;
    this.ttlMs = ttlMs;
    this.cache = cache;
    const key = Buffer.from(keyHex, 'hex');
    this.encryptionKey = Buffer.from(hkdfSync('sha256', key, Buffer.from('veylo.cloud.v1'), Buffer.from(`encryption:${scope}`), 32));
    this.indexKey = Buffer.from(hkdfSync('sha256', key, Buffer.from('veylo.cloud.v1'), Buffer.from(`index:${scope}`), 32));
    this.ready = null;
  }

  async initialize() {
    this.ready ??= this.client.batch([
      `CREATE TABLE IF NOT EXISTS ${ROOT} (scope TEXT PRIMARY KEY, owner TEXT, fence INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, manifest BLOB, updated_at INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS ${CHUNKS} (scope TEXT NOT NULL, id TEXT NOT NULL, payload BLOB NOT NULL,
        plain_bytes INTEGER NOT NULL, PRIMARY KEY (scope, id))`,
    ], 'write').catch(error => { this.ready = null; throw error; });
    await this.ready;
  }

  tag(data) { return createHmac('sha256', this.indexKey).update(data).digest('hex'); }
  trimCache(ids) {
    const keep = new Set(ids);
    for (const id of this.cache.keys()) if (!keep.has(id)) this.cache.delete(id);
  }
  aad(context) { return Buffer.from(`veylo.cloud.v1\0${this.scope}\0${context}`); }
  seal(data, context) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(this.aad(context));
    const payload = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), payload]);
  }
  open(value, context) {
    try {
      const payload = bytes(value);
      if (payload.length < 29 || payload[0] !== 1) throw integrity();
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, payload.subarray(1, 13));
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(payload.subarray(13, 29));
      return Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]);
    } catch { throw integrity(); }
  }
  decodeManifest(value, revision) {
    if (value === null) { if (revision !== 0) throw integrity(); return null; }
    const raw = this.open(value, `manifest:${revision}`);
    if (raw.length > MAX_MANIFEST_BYTES) throw integrity();
    let manifest;
    try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw integrity(); }
    if (manifest?.schema !== 1 || manifest.revision !== revision || manifest.chunkBytes !== CLOUD_CHUNK_BYTES ||
        !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) throw integrity();
    const names = new Set();
    let total = 0;
    for (const file of manifest.files) {
      try { validName(file.name); } catch { throw integrity(); }
      if (names.has(file.name) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !ID.test(file.digest) ||
          !Array.isArray(file.chunks) || file.chunks.length !== Math.ceil(file.bytes / CLOUD_CHUNK_BYTES) ||
          file.chunks.some(id => typeof id !== 'string' || !ID.test(id))) throw integrity();
      names.add(file.name);
      total += file.bytes;
      if (total > MAX_BYTES) throw integrity();
    }
    return manifest;
  }

  async acquire() {
    await this.initialize();
    await this.client.execute({sql: `INSERT OR IGNORE INTO ${ROOT} (scope) VALUES (?)`, args: [this.scope]});
    const owner = randomUUID();
    const result = await this.client.execute({
      sql: `UPDATE ${ROOT} SET owner = ?, fence = fence + 1, lease_until = ${NOW} + ?
        WHERE scope = ? AND (owner IS NULL OR lease_until <= ${NOW}) RETURNING fence, revision, manifest`,
      args: [owner, this.ttlMs, this.scope],
    });
    if (result.rows.length !== 1) throw busy();
    const row = result.rows[0];
    const lease = {vault: this, owner, fence: number(row.fence), revision: number(row.revision), lost: false, loaded: false};
    try {
      lease.manifest = this.decodeManifest(row.manifest, lease.revision);
      lease.loaded = lease.manifest === null;
      return lease;
    } catch (error) { await this.release(lease).catch(() => {}); throw error; }
  }

  checkLease(lease) { if (!lease || lease.vault !== this || lease.lost) throw lost(); }
  async assertActive(lease) {
    this.checkLease(lease);
    const result = await this.client.execute({
      sql: `SELECT revision FROM ${ROOT} WHERE scope = ? AND owner = ? AND fence = ? AND lease_until > ${NOW}`,
      args: [this.scope, lease.owner, lease.fence],
    });
    if (result.rows.length !== 1 || number(result.rows[0].revision) !== lease.revision) { lease.lost = true; throw lost(); }
  }
  async renew(lease) {
    this.checkLease(lease);
    const result = await this.client.execute({
      sql: `UPDATE ${ROOT} SET lease_until = ${NOW} + ? WHERE scope = ? AND owner = ? AND fence = ? AND lease_until > ${NOW}`,
      args: [this.ttlMs, this.scope, lease.owner, lease.fence],
    });
    if (result.rowsAffected !== 1) { lease.lost = true; throw lost(); }
  }
  async release(lease) {
    if (!lease || lease.vault !== this) return;
    try {
      await this.client.execute({
        sql: `UPDATE ${ROOT} SET owner = NULL, lease_until = 0 WHERE scope = ? AND owner = ? AND fence = ?`,
        args: [this.scope, lease.owner, lease.fence],
      });
    } finally { lease.lost = true; }
  }
  startHeartbeat(lease, onLost = () => {}) {
    let pending = false;
    let stopped = false;
    const timer = setInterval(() => {
      if (pending || stopped || lease.lost) return;
      pending = true;
      this.renew(lease).catch(() => { lease.lost = true; if (!stopped) onLost(); }).finally(() => { pending = false; });
    }, Math.min(10000, Math.floor(this.ttlMs / 3)));
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
  }

  async readFiles(lease) {
    await this.assertActive(lease);
    const manifest = lease.manifest;
    if (!manifest) { lease.loaded = true; return new Map(); }
    const ids = [...new Set(manifest.files.flatMap(file => file.chunks))];
    const missing = ids.filter(id => !this.cache.has(id));
    for (let offset = 0; offset < missing.length; offset += 16) {
      const group = missing.slice(offset, offset + 16);
      const result = await this.client.execute({
        sql: `SELECT id, payload, plain_bytes FROM ${CHUNKS} WHERE scope = ? AND id IN (${group.map(() => '?').join(',')})`,
        args: [this.scope, ...group],
      });
      if (result.rows.length !== group.length) throw integrity();
      for (const row of result.rows) {
        const data = this.open(row.payload, `chunk:${row.id}`);
        if (data.length !== number(row.plain_bytes) || data.length > CLOUD_CHUNK_BYTES || this.tag(data) !== row.id) throw integrity();
        this.cache.set(row.id, data);
      }
    }
    const files = new Map();
    for (const file of manifest.files) {
      const parts = file.chunks.map(id => {
        const data = this.cache.get(id);
        if (!data || this.tag(data) !== id) throw integrity();
        return data;
      });
      const data = Buffer.concat(parts);
      if (data.length !== file.bytes || this.tag(data) !== file.digest) throw integrity();
      files.set(file.name, data);
    }
    await this.assertActive(lease);
    lease.loaded = true;
    this.trimCache(ids);
    return files;
  }

  async checkpoint(lease, input) {
    await this.assertActive(lease);
    if (!lease.loaded) throw invalid('Read the current snapshot before replacing it.');
    const files = input instanceof Map ? [...input.entries()] : Object.entries(input || {});
    if (files.length > MAX_FILES) throw invalid('Too many snapshot files.');
    const seen = new Set();
    const existing = new Set(lease.manifest?.files.flatMap(file => file.chunks) || []);
    const fresh = new Map();
    const entries = [];
    let total = 0;
    for (const [name, value] of files.sort(([a], [b]) => a.localeCompare(b))) {
      validName(name);
      if (seen.has(name)) throw invalid('Duplicate snapshot file.');
      seen.add(name);
      const data = bytes(value);
      total += data.length;
      if (total > MAX_BYTES) throw invalid('Snapshot exceeds the supported 256 MiB limit.');
      const ids = [];
      for (let offset = 0; offset < data.length; offset += CLOUD_CHUNK_BYTES) {
        const part = data.subarray(offset, offset + CLOUD_CHUNK_BYTES);
        const id = this.tag(part);
        ids.push(id);
        if (!existing.has(id)) fresh.set(id, Buffer.from(part));
      }
      entries.push({name, bytes: data.length, digest: this.tag(data), chunks: ids});
    }
    if (lease.manifest && JSON.stringify(entries) === JSON.stringify(lease.manifest.files)) {
      await this.assertActive(lease);
      return {revision: lease.revision, files: entries.length, bytes: total, newChunks: 0, unchanged: true};
    }
    const nextRevision = lease.revision + 1;
    const manifest = {schema: 1, revision: nextRevision, chunkBytes: CLOUD_CHUNK_BYTES, files: entries};
    const encoded = Buffer.from(JSON.stringify(manifest));
    if (encoded.length > MAX_MANIFEST_BYTES) throw invalid('Snapshot file index is too large.');
    const staged = [...fresh.entries()];
    for (let offset = 0; offset < staged.length; offset += 12) {
      await this.assertActive(lease);
      await this.client.batch(staged.slice(offset, offset + 12).map(([id, data]) => ({
        sql: `INSERT INTO ${CHUNKS} (scope, id, payload, plain_bytes) SELECT ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM ${ROOT} WHERE scope = ? AND owner = ? AND fence = ? AND lease_until > ${NOW})
          ON CONFLICT (scope, id) DO NOTHING`,
        args: [this.scope, id, this.seal(data, `chunk:${id}`), data.length, this.scope, lease.owner, lease.fence],
      })), 'write');
    }
    const result = await this.client.execute({
      sql: `UPDATE ${ROOT} SET manifest = ?, revision = revision + 1, updated_at = ${NOW}, lease_until = ${NOW} + ?
        WHERE scope = ? AND owner = ? AND fence = ? AND revision = ? AND lease_until > ${NOW}`,
      args: [this.seal(encoded, `manifest:${nextRevision}`), this.ttlMs, this.scope, lease.owner, lease.fence, lease.revision],
    });
    if (result.rowsAffected !== 1) { lease.lost = true; throw lost(); }
    for (const [id, data] of staged) this.cache.set(id, data);
    lease.revision = nextRevision;
    lease.manifest = manifest;
    this.trimCache(entries.flatMap(file => file.chunks));
    return {revision: nextRevision, files: entries.length, bytes: total, newChunks: fresh.size};
  }

  async removeCheckScope(lease) {
    if (!this.scope.startsWith('check-')) throw invalid('Only an isolated check scope can be removed by this helper.');
    await this.assertActive(lease);
    // One short transaction; wallet work will never hold a SQL transaction open.
    const transaction = await this.client.transaction('write');
    try {
      const owned = await transaction.execute({
        sql: `SELECT 1 FROM ${ROOT} WHERE scope = ? AND owner = ? AND fence = ? AND lease_until > ${NOW}`,
        args: [this.scope, lease.owner, lease.fence],
      });
      if (owned.rows.length !== 1) throw lost();
      await transaction.execute({sql: `DELETE FROM ${CHUNKS} WHERE scope = ?`, args: [this.scope]});
      await transaction.execute({sql: `DELETE FROM ${ROOT} WHERE scope = ?`, args: [this.scope]});
      await transaction.commit();
      lease.lost = true;
    } catch (error) { await transaction.rollback().catch(() => {}); throw error; }
    finally { transaction.close(); }
  }
}

export async function checkCloudStorage(clientFactory, keyHex) {
  const scope = `check-${randomUUID()}`;
  const firstClient = clientFactory();
  const secondClient = clientFactory();
  const first = new CloudVault(firstClient, keyHex, {scope});
  const second = new CloudVault(secondClient, keyHex, {scope});
  let firstLease, secondLease;
  const sample = Buffer.concat([Buffer.from('Veylo storage test. No wallet data.\n'), randomBytes(CLOUD_CHUNK_BYTES * 2 + 37)]);
  try {
    firstLease = await first.acquire();
    await second.initialize();
    let excluded = false;
    try { const unexpected = await second.acquire(); await second.release(unexpected); }
    catch (error) { if (error.code !== 'VEYLO_CLOUD_BUSY') throw error; excluded = true; }
    if (!excluded) throw invalid('Concurrent-writer exclusion failed.');
    await first.checkpoint(firstLease, new Map([['check/sample.bin', sample], ['check/empty.txt', Buffer.alloc(0)]]));
    const persisted = await firstClient.execute({sql: `SELECT manifest FROM ${ROOT} WHERE scope = ?`, args: [scope]});
    const encrypted = bytes(persisted.rows[0].manifest);
    if (encrypted.includes(Buffer.from('check/sample.bin'))) throw invalid('Snapshot index was stored without encryption.');
    await first.release(firstLease);
    firstLease = null;
    firstClient.close();
    secondLease = await second.acquire();
    const restored = await second.readFiles(secondLease);
    if (restored.size !== 2 || !restored.get('check/sample.bin')?.equals(sample) || restored.get('check/empty.txt')?.length !== 0) throw integrity();
    await second.removeCheckScope(secondLease);
    secondLease = null;
    return {
      ok: true,
      writeReadVerified: true,
      persistedAcrossClients: true,
      concurrentWriterExcluded: true,
      encrypted: true,
      sampleBytes: sample.length,
      walletSecretsUsed: false,
      transactionsSent: 0,
      scope: 'Storage foundation check only. Existing purchases and wallet files have not been migrated.',
    };
  } finally {
    if (firstLease) await first.release(firstLease).catch(() => {});
    if (secondLease) {
      await second.removeCheckScope(secondLease).catch(async () => { await second.release(secondLease).catch(() => {}); });
    }
    try { firstClient.close(); } catch {}
    try { secondClient.close(); } catch {}
  }
}
