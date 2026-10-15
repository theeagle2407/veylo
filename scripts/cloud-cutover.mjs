import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {createClient as createWebClient} from '@libsql/client/web';
import {CloudVault, cloudClient} from '../cloud-state.mjs';
import {assertPrivatePaths, capturePreview, localSettings, previewRuntimeKey, redact, run, validateProject, VERCEL_VERSION, BRANCH, PROJECT, SCOPE} from './cloud-migration.mjs';

export const ORIGIN = 'https://veylo-steel.vercel.app';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHA = /^[a-f0-9]{40}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = message => Object.assign(Error(message), {safe: true});
let phase = 'initial cutover checks';
const PUBLIC_FILES = ['scripts/cloud-cutover.mjs', 'test/cloud-cutover.test.mjs'];

function git(root, args) {return execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();}
function privateDirectory(root) {const d = path.join(root, '.veylo-cloud'); fs.mkdirSync(d, {recursive: true, mode: 0o700}); return d;}
function planPath(root) {return path.join(privateDirectory(root), 'cutover.json');}
function writePlan(root, value) {
  const dest = planPath(root); fs.writeFileSync(dest + '.tmp', JSON.stringify(value, null, 2), {mode: 0o600}); fs.renameSync(dest + '.tmp', dest);
}
function readPlan(root) {
  const p = JSON.parse(fs.readFileSync(planPath(root)));
  if (p.schema !== 1 || !/^[a-f0-9-]{36}$/.test(p.id || '') || !SHA.test(p.releaseSha || '') || !/^prj_[A-Za-z0-9]+$/.test(p.projectId || '')) throw safe('The private cutover record is invalid. Preserve it and paste this message.');
  return p;
}
function credentials(root) {
  const f = path.join(root, '.env.cloud'), env = parseEnv(fs.readFileSync(f, 'utf8'));
  if (!/^[a-f0-9]{64}$/i.test(env.VEYLO_CLOUD_KEY || '') || !env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw safe('Preserve the original .env.cloud configuration.');
  fs.chmodSync(f, 0o600); return env;
}
export function migrationClient(env) {
  // Reuse the existing URL/token validation, without making a request.
  const checked = cloudClient(env); checked.close();
  return createWebClient({
    url: 'https://' + new URL(env.TURSO_DATABASE_URL).hostname,
    authToken: env.TURSO_AUTH_TOKEN, intMode: 'number', concurrency: 1,
    fetch: request => fetch(request, {signal: AbortSignal.any([request.signal, AbortSignal.timeout(45000)].filter(Boolean))}),
  });
}
export async function readSelectedMetadata(client, key, {scope = 'preview', names = ['config.json', 'data/state.json', 'runtime.json'], progress = () => {}, onRetry = () => {}} = {}) {
  return readVaultMetadata(new CloudVault(client, key, {scope}), {names, progress,
    execute: statement => metadataRead(client, statement, 'read ' + scope + ' metadata', onRetry)});
}
async function readVaultMetadata(vault, {names, progress = () => {}, execute = statement => vault.client.execute(statement)}) {
  const {scope} = vault;
  const allowed = new Set(['config.json', 'data/state.json', 'runtime.json', 'identity.txt']);
  if (!['main', 'preview'].includes(scope) || !Array.isArray(names) || !names.length || new Set(names).size !== names.length || names.some(name => !allowed.has(name))) throw safe('Invalid migration metadata selection.');
  // Versioned chunks are immutable. Authenticate a captured manifest and its
  // selected chunks; do not initialize tables, acquire a lease or update state.
  const result = await execute({sql: 'SELECT revision, manifest FROM veylo_cloud_root_v1 WHERE scope = ?', args: [scope]});
  if (result.rows.length !== 1) throw safe('The encrypted ' + scope + ' snapshot is missing. No data was changed.');
  const revision = Number(result.rows[0].revision);
  const manifest = vault.decodeManifest(result.rows[0].manifest, revision);
  if (!manifest) throw safe('The encrypted ' + scope + ' snapshot is empty.');
  if (scope === 'preview' && manifest.files.some(file => file.name === 'identity.txt')) throw safe('The Preview must not contain a signing identity.');
  const selected = names.map(name => manifest.files.find(file => file.name === name));
  if (selected.some(file => !file)) throw safe('A required ' + scope + ' metadata file is missing.');
  if (selected.reduce((sum, file) => sum + file.bytes, 0) > 16 * 1048576) throw safe('Saved migration metadata exceeds the 16 MiB read limit. No wallet files were downloaded.');
  const ids = [...new Set(selected.flatMap(file => file.chunks))], chunks = new Map();
  let requests = 1;
  for (let offset = 0; offset < ids.length; offset += 2) {
    const group = ids.slice(offset, offset + 2);
    progress({loaded: offset, total: ids.length, requests});
    const rows = await execute({sql: `SELECT id, payload, plain_bytes FROM veylo_cloud_chunks_v1 WHERE scope = ? AND id IN (${group.map(() => '?').join(',')})`, args: [scope, ...group]});
    requests++;
    if (rows.rows.length !== group.length) throw safe('A saved metadata chunk is no longer available. No records were changed.');
    for (const row of rows.rows) {
      if (!group.includes(row.id) || chunks.has(row.id)) throw safe('The metadata response contained unexpected chunks.');
      const bytes = vault.open(row.payload, 'chunk:' + row.id);
      if (bytes.length !== Number(row.plain_bytes) || bytes.length > 65536 || vault.tag(bytes) !== row.id) throw safe('Encrypted metadata failed authentication. Preserve the existing key.');
      chunks.set(row.id, bytes);
    }
  }
  const files = new Map();
  for (const file of selected) {
    const bytes = Buffer.concat(file.chunks.map(id => chunks.get(id)));
    if (bytes.length !== file.bytes || vault.tag(bytes) !== file.digest) throw safe('The saved metadata file failed authentication.');
    files.set(file.name, bytes);
  }
  progress({loaded: ids.length, total: ids.length, requests});
  return {files, manifest, revision, requests};
}
export function vercelArguments(root, args, curl) {
  const all = ['--yes', 'vercel@' + VERCEL_VERSION, ...args, '--scope', SCOPE];
  // CLI 64.2.0 forwards --cwd and --no-color to the system curl command.
  // The subprocess already has cwd=root, and NO_COLOR is set in its environment.
  if (curl) all.push('--', ...curl);
  else all.push('--cwd', root, '--no-color');
  return all;
}
async function vc(root, args, {input, curl, timeout = 120000} = {}) {
  const all = vercelArguments(root, args, curl);
  try {return await run('npx', all, {cwd: root, input, timeout, env: {...process.env, NO_UPDATE_NOTIFIER: '1', VERCEL_TELEMETRY_DISABLED: '1', NO_COLOR: '1'}});}
  catch (error) {error.vercel = true; throw error;}
}
async function api(root, endpoint, body) {
  let file;
  try {
    const args = ['api', endpoint, '--method', body === undefined ? 'GET' : 'POST', '--raw'];
    if (body !== undefined) {file = path.join(privateDirectory(root), 'api-' + randomUUID() + '.json'); fs.writeFileSync(file, JSON.stringify(body), {mode: 0o600}); args.push('--input', file);}
    return JSON.parse((await vc(root, args)).stdout);
  } finally {if (file) fs.rmSync(file, {force: true});}
}
async function project(root) {
  const link = JSON.parse(fs.readFileSync(path.join(root, '.vercel/project.json')));
  if (!/^prj_[A-Za-z0-9]+$/.test(link.projectId || '')) throw safe('The existing Vercel project link is invalid.');
  return validateProject(link, await api(root, '/v9/projects/' + link.projectId));
}
export function deploymentView(value, projectId, expectedSha) {
  const id = value.id || value.uid, hostname = value.url;
  if (!/^dpl_[A-Za-z0-9]+$/.test(id || '') || !/^[A-Za-z0-9.-]+\.vercel\.app$/.test(hostname || '') || value.projectId !== projectId || value.target !== 'production') throw safe('The deployment is not a production deployment of this Veylo project.');
  const observedSha = value.gitSource?.sha || value.meta?.githubCommitSha;
  if (expectedSha && ((value.readyState || value.state) === 'READY' || observedSha) && observedSha !== expectedSha) throw safe('The production deployment does not contain the verified release commit.');
  return {id, hostname, readyState: value.readyState || value.state, url: 'https://' + hostname};
}
export function stagedRequest(projectId, repoId, releaseSha, id) {
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId) || !/^\d+$/.test(String(repoId)) || !SHA.test(releaseSha)) throw safe('The linked Git source is invalid.');
  // This is the exact autoAssignCustomDomains field used by CLI 64.2.0 --skip-domain.
  return {name: PROJECT, project: projectId, target: 'production', source: 'cli', autoAssignCustomDomains: false,
    gitSource: {type: 'github', repoId, ref: BRANCH, sha: releaseSha}, meta: {veyloCutover: id}};
}
export function previewProof(files, now = Date.now()) {
  const config = JSON.parse(files.get('config.json') || 'null');
  if (config?.paymentMode !== 'testnet' || config.active !== false || files.has('identity.txt')) throw safe('The Preview must remain testnet-only and have no signing identity.');
  const runtime = JSON.parse(files.get('runtime.json') || '{}');
  const found = Object.values(runtime.operations || {}).flatMap(operation => {
    if (operation.response?.status !== 200) return [];
    try {
      const x = JSON.parse(Buffer.from(operation.response.base64, 'base64'));
      const age = now - Date.parse(x.checkedAt);
      return x.ok === true && x.cloudRecoveryVerified === true && x.transactionsSent === 0 && Number.isSafeInteger(x.chainHeight) && x.chainHeight > 0 && Number.isSafeInteger(x.walletTransactions) && x.walletTransactions >= 0 && age >= -60000 && age < 86400000 ? [x] : [];
    } catch {return [];}
  }).sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
  if (!found.length) throw safe('Complete the actual Preview wallet check before preparing production.');
  return {account: config.account, issuer: JSON.parse(files.get('data/state.json')).publicKey.x, check: found[0]};
}
export function ageIdentity(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 60 || bytes.length > 16384 || !/^AGE-SECRET-KEY-1[A-Z0-9]{40,100}\s*$/m.test(bytes.toString('utf8'))) throw safe('The configured testnet wallet identity must be a regular age identity file. Its contents were kept private.');
  return bytes;
}
export function accountIndex(text, account) {
  const block = text.split(/(?=^Account )/m).find(part => part.startsWith('Account ' + account + ' (birthday height '));
  const matches = [...(block || '').matchAll(/^\s+Account index: (\d+)\s*$/gm)];
  if (matches.length !== 1 || Number(matches[0][1]) >= 2147483648) throw safe('The existing spending account derivation could not be verified. No wallet was initialized.');
  return Number(matches[0][1]);
}
export async function captureProduction(root, {settings = localSettings(root), checkWallet = true, runner = run} = {}) {
  if (!settings.VEYLO_SELLER_IDENTITY) throw safe('The existing testnet identity path is missing from .env.testnet.');
  const raw = settings.VEYLO_SELLER_IDENTITY;
  const source = path.resolve(root, raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
  if (!fs.existsSync(source) || !fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw safe('The configured testnet identity file is missing or linked. The original file was preserved.');
  const identity = ageIdentity(fs.readFileSync(source));
  const snap = await capturePreview(root, {settings, checkWallet});
  try {
    const file = path.join(snap.directory, 'identity.txt'); fs.writeFileSync(file, identity, {mode: 0o600});
    if (checkWallet) {
      const accounts = await runner(settings.binary, ['wallet', '-w', path.join(snap.directory, 'wallet'), 'list-accounts'], {timeout: 30000});
      const index = accountIndex(accounts.stdout, settings.VEYLO_SELLER_ACCOUNT);
      const derived = await runner(settings.binary, ['wallet', '-w', path.join(snap.directory, 'wallet'), 'derive-path', '--identity', file, 'orchard', "m/32'/1'/" + index + "'"], {timeout: 30000});
      if (!/^ - UFVK: \S+$/m.test(derived.stdout) || derived.stdout.includes('does not match')) throw safe('Read-only testnet signing-key validation failed. No transaction was sent.');
    }
    snap.files.set('identity.txt', identity); snap.identityDigest = sha(identity);
    return snap;
  } catch (error) {fs.rmSync(snap.directory, {recursive: true, force: true}); throw error;}
}
async function locked(vault, action) {
  const lease = await vault.acquire(), stop = vault.startHeartbeat(lease);
  try {return await action(lease, await vault.readFiles(lease));}
  finally {stop(); await vault.release(lease);}
}
export async function importProduction(vault, input, {id, issuer}) {
  if (vault.scope !== 'main') throw safe('Production imports require the main storage scope.');
  const incoming = new Map(input), config = JSON.parse(incoming.get('config.json'));
  if (config.paymentMode !== 'testnet' || config.active !== false || JSON.parse(incoming.get('data/state.json')).publicKey.x !== issuer) throw safe('Production import does not match the verified testnet merchant.');
  ageIdentity(incoming.get('identity.txt'));
  return locked(vault, async (lease, old) => {
    if (old.size) {
      let previous; try {previous = JSON.parse(old.get('config.json'));} catch {}
      if (previous?.cutoverId !== id || previous.account !== config.account || previous.paymentMode !== 'testnet' || JSON.parse(old.get('data/state.json') || 'null')?.publicKey?.x !== issuer || !old.get('identity.txt')?.equals(incoming.get('identity.txt'))) throw safe('Production storage already contains different data. It was preserved.');
      return {revision: lease.revision, issuer, account: previous.account, applicationDigest: sha(old.get('data/state.json')), identityDigest: sha(old.get('identity.txt')), resumed: true};
    }
    incoming.set('config.json', Buffer.from(JSON.stringify({...config, active: false, cutoverId: id})));
    const saved = await vault.checkpoint(lease, incoming);
    return {revision: saved.revision, issuer, account: config.account, applicationDigest: sha(incoming.get('data/state.json')), identityDigest: sha(incoming.get('identity.txt'))};
  });
}
function networkFailure(error) {
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return true;
  if (error?.name === 'TypeError' && /fetch failed|failed to fetch|terminated|network/i.test(error.message || '')) return true;
  const code = String(error?.code || error?.cause?.code || '');
  return /^(?:UND_ERR_|ECONN|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)/.test(code);
}
function atStep(error, step) {
  if (error && typeof error === 'object') error.cutoverStep ??= step;
  return error;
}
async function metadataRead(client, statement, step, progress) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {return await client.execute(statement);}
    catch (error) {
      atStep(error, step);
      if (!networkFailure(error) || attempt === 2) throw error;
      progress(step + ': retrying a read after a connection failure (' + (attempt + 1) + '/2).');
    }
  }
}
function activationConfig(files, plan) {
  let config, state;
  try {config = JSON.parse(files.get('config.json')); state = JSON.parse(files.get('data/state.json'));}
  catch {throw safe('Saved activation metadata is invalid. Its contents were kept private.');}
  if (config?.schema !== 1 || config.cutoverId !== plan.id || config.paymentMode !== 'testnet' ||
      config.account !== plan.imported?.account || state?.publicKey?.x !== plan.imported?.issuer ||
      !files.has('identity.txt') || sha(files.get('identity.txt')) !== plan.imported?.identityDigest ||
      ![true, false].includes(config.active)) throw safe('The production merchant or identity does not match this cutover. No activation was made.');
  return config;
}
export function savedProductionCheck(plan, now = Date.now()) {
  const check = plan.productionCheck, age = now - Date.parse(check?.checkedAt);
  return check?.ok === true && check.cloudRecoveryVerified === true && check.transactionsSent === 0 &&
    Number.isSafeInteger(check.chainHeight) && check.chainHeight > 0 && Number.isSafeInteger(check.walletTransactions) && check.walletTransactions >= 0 &&
    age >= -60000 && age < 3600000 && (!plan.productionCheckedDeployment || plan.productionCheckedDeployment === plan.deployment?.id);
}
export async function activateProduction(vault, plan, {progress = () => {}} = {}) {
  if (vault.scope !== 'main') throw safe('Production activation requires the main storage scope.');
  const names = ['config.json', 'data/state.json', 'identity.txt'];
  const metadata = async () => readVaultMetadata(vault, {names,
    execute: statement => metadataRead(vault.client, statement, statement.sql.includes('root_v1') ? 'read activation manifest' : 'read activation metadata chunks', progress),
  });
  // A single conditional manifest update is serialized with the application's
  // normal leases. Never acquire a lease or download wallet database chunks here.
  for (let attempt = 0; attempt < 3; attempt++) {
    progress('Verifying activation metadata (' + (attempt + 1) + '/3).');
    const snapshot = await metadata(), config = activationConfig(snapshot.files, plan);
    if (config.active) return {revision: snapshot.revision, alreadyActive: true};
    const bytes = Buffer.from(JSON.stringify({...config, active: true}));
    if (bytes.length > 65536) throw safe('Activation configuration exceeds one encrypted chunk. Existing data was preserved.');
    const id = vault.tag(bytes), entry = {name: 'config.json', bytes: bytes.length, digest: id, chunks: [id]};
    const staged = {sql: 'INSERT INTO veylo_cloud_chunks_v1 (scope, id, payload, plain_bytes) VALUES (?, ?, ?, ?) ON CONFLICT (scope, id) DO NOTHING',
      args: ['main', id, vault.seal(bytes, 'chunk:' + id), bytes.length]};
    let prepared = false;
    for (let n = 0; n < 2 && !prepared; n++) {
      let writeError;
      try {await vault.client.execute(staged);}
      catch (error) {atStep(error, 'stage encrypted activation configuration'); if (!networkFailure(error)) throw error; writeError = error;}
      const found = await metadataRead(vault.client, {sql: 'SELECT id, payload, plain_bytes FROM veylo_cloud_chunks_v1 WHERE scope = ? AND id = ?', args: ['main', id]}, 'verify prepared activation configuration', progress);
      if (!found.rows.length && writeError && n === 0) continue; // Immutable INSERT is idempotent; first verify its outcome.
      if (found.rows.length !== 1) throw writeError || safe('The prepared activation configuration is missing. Existing data was preserved.');
      const row = found.rows[0], opened = vault.open(row.payload, 'chunk:' + id);
      if (row.id !== id || Number(row.plain_bytes) !== bytes.length || vault.tag(opened) !== id || !opened.equals(bytes)) throw safe('Prepared activation configuration could not be authenticated.');
      prepared = true;
    }
    const revision = snapshot.revision + 1;
    const next = {...snapshot.manifest, revision, files: snapshot.manifest.files.map(file => file.name === 'config.json' ? entry : file)};
    const encoded = vault.seal(Buffer.from(JSON.stringify(next)), 'manifest:' + revision);
    vault.decodeManifest(encoded, revision);
    let changed, uncertain;
    progress('Committing the activation setting.');
    try {
      changed = await vault.client.execute({sql: `UPDATE veylo_cloud_root_v1 SET manifest = ?, revision = revision + 1, updated_at = (unixepoch() * 1000)
        WHERE scope = ? AND revision = ? AND (owner IS NULL OR lease_until <= (unixepoch() * 1000))`, args: [encoded, 'main', snapshot.revision]});
    } catch (error) {atStep(error, 'commit activation setting'); if (!networkFailure(error)) throw error; uncertain = error;}
    // Do not replay an uncertain write. Read and authenticate the stored result.
    let observed;
    try {observed = await metadata();}
    catch (error) {
      if (uncertain || changed?.rowsAffected === 1) throw Object.assign(safe('Activation write outcome is uncertain. Preserve the cutover record; resuming will verify the saved setting before writing.'), {code: 'VEYLO_ACTIVATION_UNCERTAIN', cutoverStep: 'verify activation commit', cause: error});
      throw error;
    }
    if (activationConfig(observed.files, plan).active) {
      progress('Activation verified from encrypted storage.');
      return {revision: observed.revision, recovered: Boolean(uncertain), configOnly: true};
    }
    if (changed?.rowsAffected === 1) throw safe('The activation setting changed again during verification. Existing data was preserved.');
    progress('A concurrent request prevented activation; verifying the latest state before another attempt.');
  }
  throw Object.assign(safe('Another request is still using production storage. No snapshot was replaced. Resume the same cutover after it finishes.'), {code: 'VEYLO_CLOUD_BUSY'});
}
export function cutoverFailureDetails(error, context, secrets = []) {
  const clean = value => redact(String(value || ''), secrets).replace(/(?:https?|libsql):\/\/\S+/g, '[private URL]').replace(/\b[a-f0-9]{64}\b/ig, '[private value]').slice(0, 600);
  const code = value => /^[A-Z0-9_]{1,80}$/i.test(String(value || '')) ? String(value) : null;
  const brief = item => ({type: /^[A-Za-z]{1,50}$/.test(item?.name || '') ? item.name : 'Error', code: code(item?.code),
    message: item?.safe || networkFailure(item) ? clean(item.message) : 'See the failing step and stack frames.'});
  return {phase: clean(context), step: error?.cutoverStep ? clean(error.cutoverStep) : null, ...brief(error),
    causes: [error?.cause, ...(error?.cause?.errors || [])].filter(Boolean).map(brief),
    frames: String(error?.stack || '').split('\n').slice(1).filter(line => /^\s+at /.test(line)).slice(0, 7).map(clean)};
}
export async function publicCloudHealth({fetcher = fetch, progress = () => {}} = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    progress('Checking the submitted URL (' + (attempt + 1) + '/3).');
    let response, health;
    try {
      response = await fetcher(ORIGIN + '/api/cloud/health?check=' + randomUUID(), {redirect: 'manual', signal: AbortSignal.timeout(20000), cache: 'no-store'});
      if ([408, 429, 502, 503, 504].includes(response.status) && attempt < 2) {await response.body?.cancel(); continue;}
      if (!response.ok) throw safe('The submitted URL returned HTTP ' + response.status + ' during its cloud health check. The cutover record was preserved.');
      try {health = await response.json();} catch {throw safe('The submitted URL returned a non-JSON cloud health response. The cutover record was preserved.');}
    } catch (error) {atStep(error, 'verify submitted URL health'); if (networkFailure(error) && attempt < 2) continue; throw error;}
    if (health?.ok !== true || health.mode !== 'live' || health.storage !== 'encrypted' || health.network !== 'Zcash testnet') throw safe('The submitted URL did not report live encrypted Zcash testnet storage. The cutover record was preserved.');
    return health;
  }
}
function processExists(pid) {try {process.kill(pid, 0); return true;} catch (e) {if (e.code === 'ESRCH') return false; throw e;}}
async function sameLocalServer(root, pid) {
  if (!Number.isSafeInteger(pid) || pid < 2 || !processExists(pid)) return false;
  const cwd = await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const location = cwd.stdout.split(/\r?\n/).find(line => line.startsWith('n'))?.slice(1);
  if (!location || fs.realpathSync(location) !== fs.realpathSync(root)) return false;
  const command = (await run('/bin/ps', ['-p', String(pid), '-o', 'comm='])).stdout.trim();
  return /(?:^|\/)node$/.test(command);
}
async function pauseLocal(root, plan) {
  if (process.platform !== 'darwin') throw safe('Run the final cutover on the Mac holding the original wallet.');
  if (plan.localPaused && plan.localPid && await sameLocalServer(root, plan.localPid)) {
    if (!(await run('/bin/ps', ['-p', String(plan.localPid), '-o', 'stat='])).stdout.includes('T')) throw safe('The local server resumed. Preserve the cutover record and paste this message before continuing.');
    return;
  }
  const settings = localSettings(root), port = Number(settings.PORT || process.env.PORT || 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw safe('The configured local server port is invalid.');
  let output = '';
  try {output = (await run('/usr/sbin/lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'])).stdout;}
  catch (e) {if (e.code !== 1) throw e;}
  const pids = [...new Set(output.trim().split(/\s+/).filter(Boolean).map(Number))];
  if (pids.length > 1 || pids.length === 1 && !await sameLocalServer(root, pids[0])) throw safe('The configured port belongs to another process. No process was paused.');
  if (!pids.length) {plan.localPaused = true; plan.localPid = null; writePlan(root, plan); return;}
  const pid = pids[0];
  process.kill(pid, 'SIGSTOP');
  try {
    if (!(await run('/bin/ps', ['-p', String(pid), '-o', 'stat='])).stdout.includes('T')) throw safe('The local server did not pause.');
    let children = '';
    try {children = (await run('/usr/bin/pgrep', ['-P', String(pid)])).stdout.trim();} catch (e) {if (e.code !== 1) throw e;}
    if (children) throw safe('The local wallet is finishing a command. The server was resumed. Wait for that command to finish, then run switch again.');
    plan.localPaused = true; plan.localPid = pid; writePlan(root, plan);
  } catch (error) {process.kill(pid, 'SIGCONT'); throw error;}
}
export function parseCurl(output) {
  const match = /\nVEYLO_STATUS:(\d{3})\s*$/.exec(output);
  if (!match) throw safe('The protected deployment check did not return an HTTP status.');
  let data; try {data = JSON.parse(output.slice(0, match.index));} catch {throw safe('The protected deployment returned a non-JSON response (HTTP ' + match[1] + ').');}
  return {status: Number(match[1]), data};
}
async function cloudCall(root, plan, route, body, operation = randomUUID()) {
  const folder = privateDirectory(root), file = path.join(folder, 'http-' + randomUUID() + '.json'), cookies = path.join(folder, 'production-cookies.txt');
  try {
    if (body !== undefined) fs.writeFileSync(file, JSON.stringify(body), {mode: 0o600});
    if (!fs.existsSync(cookies)) fs.writeFileSync(cookies, '', {mode: 0o600});
    const args = ['--silent', '--show-error', '--max-time', '250', '--write-out', '\nVEYLO_STATUS:%{http_code}\n', '--cookie', cookies, '--cookie-jar', cookies,
      '--header', 'Origin:' + plan.deployment.url, '--header', 'X-Veylo-Operation:' + operation];
    if (body !== undefined) args.push('--request', 'POST', '--header', 'Content-Type:application/json', '--data-binary', '@' + file);
    return parseCurl((await vc(root, ['curl', route, '--deployment', plan.deployment.url], {curl: args, timeout: 270000})).stdout);
  } finally {fs.rmSync(file, {force: true});}
}
async function actualWalletCheck(root, plan, code) {
  const login = await cloudCall(root, plan, '/api/seller/login', {code});
  if (login.status !== 200 || login.data.ok !== true) throw safe('The production seller sign-in check failed (HTTP ' + login.status + '). The access code was kept private.');
  const operation = randomUUID();
  for (let n = 0; n < 12; n++) {
    console.log('Checking the actual production wallet; stage ' + (n + 1) + '...');
    const response = await cloudCall(root, plan, '/api/cloud/wallet-check', {}, operation);
    if (response.status === 200 && response.data.ok === true && response.data.cloudRecoveryVerified === true && response.data.transactionsSent === 0) return response.data;
    if (response.status !== 202 || response.data.pending !== true) throw safe('Production wallet verification stopped (HTTP ' + response.status + ', ' + (response.data.code || response.data.error || 'CHECK_FAILED') + '). No transaction was requested.');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw safe('The production wallet check has not finished. Run switch again to resume the imported wallet.');
}

export async function main(command, root = ROOT) {
  assertPrivatePaths(root);
  const env = credentials(root), linked = await project(root);
  if (command === 'prepare') {
    phase = 'verifying the tested Preview and release source';
    if (fs.existsSync(planPath(root))) {
      const existing = readPlan(root);
      if (existing.deployment) {const d = deploymentView(await api(root, '/v13/deployments/' + existing.deployment.id), existing.projectId, existing.releaseSha); console.log(JSON.stringify(d, null, 2)); console.log('Production build already prepared. Your submitted URL is unchanged.'); return;}
      throw safe('A cutover preparation already exists without a confirmed build. Preserve it and paste this message; no second build was requested.');
    }
    const pending = git(root, ['diff', '--name-only']).split('\n').filter(Boolean);
    const staged = git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    if (pending.length || staged.length) throw safe('The tested tracked source has local changes. No deployment was requested. Paste this message.');
    const releaseSha = git(root, ['rev-parse', 'HEAD']);
    if (!SHA.test(releaseSha)) throw safe('The release commit is invalid.');
    const remote = git(root, ['remote', 'get-url', 'origin']);
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:)theeagle2407\/veylo(?:\.git)?$/.test(remote)) throw safe('The Git remote is not the existing Veylo repository.');
    const remoteSha = git(root, ['ls-remote', 'origin', 'refs/heads/' + BRANCH]).split(/\s+/)[0];
    if (remoteSha !== releaseSha) throw safe('The migration branch on GitHub does not match the tested local commit.');
    phase = 'reading the saved Preview check metadata';
    const c = migrationClient(env);
    let proof;
    try {
      const metadata = await readSelectedMetadata(c, previewRuntimeKey(env.VEYLO_CLOUD_KEY), {
        progress: ({loaded, total}) => console.log('Preview metadata: ' + loaded + '/' + total + ' chunks checked.'),
        onRetry: message => console.log(message),
      });
      proof = previewProof(metadata.files);
      console.log('Saved Preview check verified. Wallet database files were not downloaded.');
    } finally {c.close();}
    phase = 'looking up the existing production deployment';
    const current = deploymentView(await api(root, '/v13/deployments/' + new URL(ORIGIN).host), linked.id);
    const p = {schema: 1, id: randomUUID(), projectId: linked.id, releaseSha, preview: proof, previous: current, createdAt: new Date().toISOString()};
    writePlan(root, p);
    phase = 'configuring production variables';
    const values = {...env, VEYLO_CLOUD_MODE: 'live', VEYLO_PUBLIC_ORIGIN: ORIGIN};
    for (const name of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'VEYLO_CLOUD_KEY', 'VEYLO_CLOUD_MODE', 'VEYLO_PUBLIC_ORIGIN']) {
      await vc(root, ['env', 'add', name, 'production', '--type', 'secret', '--force', '--yes'], {input: values[name]});
      console.log('Configured production ' + name + '; value kept private.');
    }
    phase = 'creating a production build with automatic domain assignment disabled';
    const created = await api(root, '/v13/deployments', stagedRequest(linked.id, linked.link.repoId, releaseSha, p.id));
    if (!/^dpl_[A-Za-z0-9]+$/.test(created.id || '')) throw safe('Vercel did not return a deployment identifier. Preserve the cutover record; no second build was requested.');
    p.createdId = created.id; writePlan(root, p);
    p.deployment = deploymentView(await api(root, '/v13/deployments/' + created.id), linked.id, releaseSha); writePlan(root, p);
    const stillCurrent = deploymentView(await api(root, '/v13/deployments/' + new URL(ORIGIN).host), linked.id);
    if (stillCurrent.id !== current.id) {
      if (stillCurrent.id === p.deployment.id) {
        await vc(root, ['promote', current.id, '--yes', '--timeout', '60s']);
        throw safe('Vercel assigned the new deployment early. The previous deployment was promoted again. Keep the local backend running and paste this message.');
      }
      throw safe('Another deployment changed the submitted domain. Do not stop the local backend; paste this message.');
    }
    console.log(JSON.stringify(p.deployment, null, 2));
    console.log('PRODUCTION BUILD REQUESTED. Automatic domain assignment is disabled; keep the current backend running.');
    return;
  }
  const p = readPlan(root);
  if (p.projectId !== linked.id) throw safe('The cutover belongs to another Vercel project.');
  if (command === 'status') {
    const d = deploymentView(await api(root, '/v13/deployments/' + p.deployment.id), linked.id, p.releaseSha);
    console.log(JSON.stringify(d, null, 2)); return;
  }
  if (command === 'switch') {
    phase = 'checking the staged production build';
    const d = deploymentView(await api(root, '/v13/deployments/' + p.deployment.id), linked.id, p.releaseSha);
    if (d.readyState !== 'READY') throw safe('Production is ' + d.readyState + '. Keep the current backend running; run status before trying switch again.');
    const current = deploymentView(await api(root, '/v13/deployments/' + new URL(ORIGIN).host), linked.id);
    if (![p.previous.id, d.id].includes(current.id)) throw safe('Another deployment changed the submitted domain. Nothing was paused or promoted.');
    if (p.complete && current.id === d.id) {
      const health = await publicCloudHealth({progress: message => console.log(message)});
      console.log(JSON.stringify({ok: true, url: ORIGIN, health, alreadyComplete: true}, null, 2)); return;
    }
    phase = 'pausing only the existing local Veylo server';
    console.log(p.imported ? 'Resuming the imported production snapshot.' : 'Production is ready. Briefly pausing the local server for the final consistent data copy.');
    await pauseLocal(root, p);
    const c = migrationClient(env), vault = new CloudVault(c, env.VEYLO_CLOUD_KEY, {scope: 'main', ttlMs: 300000});
    try {
      if (!p.imported) {
        phase = 'capturing and validating the final testnet wallet and identity';
        const snap = await captureProduction(root);
        try {
          if (JSON.parse(snap.files.get('data/state.json')).publicKey.x !== p.preview.issuer || JSON.parse(snap.files.get('config.json')).account !== p.preview.account) throw safe('The local merchant or wallet differs from the tested Preview.');
          p.imported = await importProduction(vault, snap.files, {id: p.id, issuer: p.preview.issuer}); writePlan(root, p);
        } finally {fs.rmSync(snap.directory, {recursive: true, force: true});}
      }
      phase = 'verifying the imported production metadata';
      const coldClient = migrationClient(env);
      let config;
      try {
        const {files} = await readSelectedMetadata(coldClient, env.VEYLO_CLOUD_KEY, {scope: 'main', names: ['config.json', 'data/state.json', 'identity.txt'], onRetry: message => console.log(message)});
        const cfg = JSON.parse(files.get('config.json'));
        if (cfg.cutoverId !== p.id || cfg.account !== p.imported.account || JSON.parse(files.get('data/state.json')).publicKey.x !== p.imported.issuer || sha(files.get('identity.txt')) !== p.imported.identityDigest) throw safe('The cold production recovery check failed.');
        config = cfg;
      } finally {coldClient.close();}
      phase = 'checking the real wallet on the production deployment';
      if (savedProductionCheck(p)) console.log('Reusing the successful production wallet check from ' + p.productionCheck.checkedAt + '.');
      else {
        p.productionCheck = await actualWalletCheck(root, p, config.sellerCode);
        p.productionCheckedDeployment = d.id; writePlan(root, p);
      }
      phase = 'activating the imported production wallet';
      p.activation = await activateProduction(vault, p, {progress: message => console.log(message)});
      p.activated = true; writePlan(root, p);
      phase = 'assigning the existing production domain';
      if (current.id !== d.id) {
        try {await vc(root, ['promote', d.id, '--yes', '--timeout', '60s']);}
        catch (error) {
          // A CLI timeout can follow a completed promotion. Check the alias before deciding.
          const observed = deploymentView(await api(root, '/v13/deployments/' + new URL(ORIGIN).host), linked.id);
          if (observed.id !== d.id) throw error;
          console.log('The submitted domain assignment was confirmed after the CLI stopped.');
        }
      }
      const now = deploymentView(await api(root, '/v13/deployments/' + new URL(ORIGIN).host), linked.id);
      if (now.id !== d.id) throw safe('Production promotion has not completed. Keep the cutover record; run switch again to check it.');
      phase = 'verifying the submitted public URL';
      const health = await publicCloudHealth({progress: message => console.log(message)});
      p.complete = true; p.completedAt = new Date().toISOString(); writePlan(root, p);
      if (p.localPid && await sameLocalServer(root, p.localPid)) {
        try {process.kill(p.localPid, 'SIGTERM'); process.kill(p.localPid, 'SIGCONT');} catch (error) {if (error.code !== 'ESRCH') throw error;}
      }
      fs.rmSync(path.join(privateDirectory(root), 'production-cookies.txt'), {force: true});
      console.log(JSON.stringify({ok: true, url: ORIGIN, deployment: d.id, cloudWallet: p.productionCheck, health, transactionsSent: 0, existingMerchantPreserved: true}, null, 2));
      console.log('VEYLO CLOUD CUTOVER PASSED. The submitted URL now uses Vercel and encrypted persistent storage.');
      console.log('Next: verify checkout and a download, then close the Cloudflare tunnel. Real cloud refund sending still needs a product-flow test.');
    } finally {c.close();}
    return;
  }
  if (command === 'publish-source') {
    if (!p.complete) throw safe('Finish and verify the production cutover before updating the main Git branch.');
    const head = git(root, ['rev-parse', 'HEAD']);
    if (![p.releaseSha, p.sourceCommit].includes(head)) throw safe('The local release commit changed. No Git branch was pushed.');
    const dirty = git(root, ['diff', '--name-only']).split('\n').filter(Boolean);
    const staged = git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    if (dirty.length || staged.some(name => !PUBLIC_FILES.includes(name))) throw safe('There are unrelated local changes. Nothing was committed or pushed.');
    git(root, ['fetch', 'origin', 'main']);
    try {git(root, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);} catch {throw safe('The main branch advanced separately. No force push was attempted.');}
    if (!p.sourceCommit) {
      git(root, ['add', '--', ...PUBLIC_FILES]); assertPrivatePaths(root); git(root, ['diff', '--cached', '--check']);
      git(root, ['commit', '-m', 'Document and verify the Vercel cloud cutover']);
      p.sourceCommit = git(root, ['rev-parse', 'HEAD']); writePlan(root, p);
    }
    execFileSync('git', ['push', 'origin', 'HEAD:main'], {cwd: root, stdio: 'inherit'});
    p.sourcePublished = true; writePlan(root, p);
    console.log('MAIN SOURCE UPDATED. The cloud app remains available while Vercel rebuilds the same application code.');
    return;
  }
  throw safe('Use: prepare, status, switch, or publish-source.');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv[2]).catch(error => {
    let values = []; try {values = Object.values(credentials(ROOT));} catch {}
    try {values.push(JSON.parse(fs.readFileSync(path.join(ROOT, '.veylo-cloud/operator.json'))).sellerCode);} catch {}
    const kind = /^[A-Za-z]{1,40}$/.test(error.name || '') ? error.name : 'Error';
    const code = /^[A-Z0-9_]{1,60}$/i.test(String(error.code || '')) ? String(error.code) : 'CHECK_FAILED';
    const message = error.safe ? error.message : error.vercel ? error.stderr || 'Vercel command did not finish.' : 'Cutover check failed while ' + phase + ' (' + kind + ', ' + code + (error.killed ? ', timeout' : '') + '). Private response contents were withheld.';
    console.error('STOPPED:', redact(message, values));
    if (!error.vercel) console.error(JSON.stringify(cutoverFailureDetails(error, phase, values), null, 2));
    try {if (readPlan(ROOT).localPaused) console.error('The local server may be paused. Preserve .env.cloud and .veylo-cloud/cutover.json and paste this output before restarting it.');} catch {}
    process.exitCode = 1;
  });
}
