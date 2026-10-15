import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn, execFileSync} from 'node:child_process';
import {parseEnv} from 'node:util';
import {createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes} from 'node:crypto';
import {CloudVault, cloudClient} from '../cloud-state.mjs';
import {Store} from '../core.mjs';
import {captureCloudFiles} from '../cloud-runtime.mjs';

export const VERCEL_VERSION = '64.2.0';
export const BRANCH = 'veylo-cloud-migration';
export const PROJECT = 'veylo';
export const SCOPE = 'theeagle2407s-projects';
const PUBLIC_ORIGIN = 'https://veylo-steel.vercel.app';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha = value => createHash('sha256').update(value).digest('hex');
const plainError = message => Object.assign(new Error(message), {safe: true});
let phase = 'initial checks';

export function previewRuntimeKey(master) {
  if (!/^[a-f0-9]{64}$/i.test(master || '')) throw plainError('Preserve the original 32-byte cloud encryption key.');
  return Buffer.from(hkdfSync('sha256', Buffer.from(master, 'hex'), Buffer.from('veylo.preview.v1'), Buffer.from('preview-runtime-only'), 32)).toString('hex');
}

export function run(command, args, {cwd = ROOT, input, timeout = 60000, env = process.env} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => {killed = true; child.kill('SIGKILL');}, timeout);
    child.stdout.on('data', b => {stdout += b; if (Buffer.byteLength(stdout) > 4 * 1048576) {killed = true; child.kill('SIGKILL');}});
    child.stderr.on('data', b => {stderr += b; if (Buffer.byteLength(stderr) > 1048576) {killed = true; child.kill('SIGKILL');}});
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', code => {clearTimeout(timer); code === 0 && !killed ? resolve({stdout, stderr}) : reject(Object.assign(Error('Private subprocess did not finish.'), {code, killed, stderr}));});
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : input);
  });
}

export function redact(value, secrets = []) {
  let text = String(value || 'Operation did not finish.');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/AGE-SECRET-KEY-[A-Z0-9]+/g, '[redacted identity]').slice(0, 2500);
}
function git(root, args) {return execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();}
export function assertPrivatePaths(root) {
  if (git(root, ['branch', '--show-current']) !== BRANCH) throw plainError('Use the veylo-cloud-migration branch.');
  if (git(root, ['ls-files', '--', '.env*', 'data/**', '*.age', '*.key', '*.pem', '.veylo-cloud/**', '.vercel/**'])) throw plainError('A private-file pattern is tracked by Git. Nothing was uploaded or pushed.');
  for (const name of ['.env.cloud', '.veylo-cloud/check', '.vercel/project.json']) {
    try {if (!git(root, ['check-ignore', '--', name])) throw Error();}
    catch {throw plainError('Private cloud paths must be ignored before continuing.');}
  }
}
export function localSettings(root, supplied = process.env) {
  const settings = {};
  for (const name of ['.env', '.env.local', '.env.testnet', '.env.hosting', '.env.public']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) Object.assign(settings, parseEnv(fs.readFileSync(file, 'utf8')));
  }
  for (const [key, value] of Object.entries(supplied)) if (key.startsWith('VEYLO_') && typeof value === 'string') settings[key] = value;
  if (settings.VEYLO_PAYMENT_MODE !== 'testnet' || !UUID.test(settings.VEYLO_SELLER_ACCOUNT || '')) throw plainError('The existing .env.testnet wallet settings are missing or invalid. No wallet was initialized.');
  const expand = value => path.resolve(root, value?.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value || '');
  if (!settings.VEYLO_WALLET_BINARY || !settings.VEYLO_SELLER_WALLET) throw plainError('The existing wallet executable or directory is missing from .env.testnet.');
  return {...settings, binary: expand(settings.VEYLO_WALLET_BINARY), wallet: expand(settings.VEYLO_SELLER_WALLET), data: expand(settings.VEYLO_DATA_DIR || 'data')};
}
export function validateState(state, assetDirectory) {
  if (state?.schema !== 1 || typeof state.secret !== 'string' || !state.purchases || !state.requests || !state.challenges || !Array.isArray(state.notices)) throw plainError('The saved application state is invalid. The original files were preserved.');
  const key = createPrivateKey(state.secret), publicKey = createPublicKey(key).export({format: 'jwk'});
  if (key.asymmetricKeyType !== 'ed25519' || publicKey.x !== state.publicKey?.x || state.publicKey.kty !== 'OKP' || state.publicKey.crv !== 'Ed25519') throw plainError('Merchant signing identity validation failed. No replacement identity was created.');
  const store = new Store(state);
  for (const p of Object.values(state.purchases)) if (p.receipt && !store.validateReceipt(p.receipt)) throw plainError('An existing purchase receipt failed signature validation. No import was made.');
  const deliveries = [...Object.values(state.merchantCatalog?.items || {}).map(p => p.delivery), ...Object.values(state.purchases).map(p => p.receipt?.delivery)].filter(Boolean);
  for (const d of deliveries) {
    if (d.schema !== 'veylo.delivery.v1' || !/^[a-f0-9]{64}$/.test(d.sha256 || '') || !Number.isSafeInteger(d.bytes) || d.bytes < 1) throw plainError('An existing product delivery record is invalid.');
    const file = path.join(assetDirectory, d.sha256);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) throw plainError('An existing product file is missing or linked outside its folder. Restore the original file before importing.');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== d.bytes || sha(bytes) !== d.sha256) throw plainError('An existing product file failed its fingerprint check.');
  }
  return {issuerFingerprint: sha(JSON.stringify(publicKey)), purchases: Object.keys(state.purchases).length,
    signedReceipts: Object.values(state.purchases).filter(p => p.receipt).length, products: Object.keys(state.merchantCatalog?.items || {}).length};
}

const SQLITE_BACKUP = String.raw`
import sqlite3, pathlib, sys, time, os
source, destination = map(pathlib.Path, sys.argv[1:3])
started = time.monotonic()
def progress(status, remaining, total):
    if time.monotonic() - started > 30:
        raise TimeoutError('backup timed out')
src = sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True, timeout=10)
dst = sqlite3.connect(str(destination), timeout=10)
try:
    src.backup(dst, pages=128, progress=progress, sleep=0.01)
    result = dst.execute('PRAGMA quick_check').fetchall()
    if result != [('ok',)]:
        raise RuntimeError('database integrity check failed')
finally:
    dst.close()
    src.close()
os.chmod(destination, 0o600)
print('SQLITE_BACKUP_OK')
`;
export async function backupSqlite(source, destination, options = {}) {
  if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) throw plainError('An expected wallet database is missing or is not a regular file.');
  fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
  const result = await run('python3', ['-c', SQLITE_BACKUP, source, destination], {timeout: 45000, ...options});
  if (result.stdout.trim() !== 'SQLITE_BACKUP_OK') throw plainError('The read-only SQLite backup check did not complete.');
}
function copyTree(source, dest) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw plainError('A snapshot path is a symbolic link. No private files were uploaded.');
  if (stat.isDirectory()) {fs.mkdirSync(dest, {recursive: true, mode: 0o700}); for (const name of fs.readdirSync(source)) {if (name === '.DS_Store' || name.endsWith('.tmp')) continue; copyTree(path.join(source, name), path.join(dest, name));} return;}
  if (!stat.isFile()) throw plainError('An unsupported snapshot file was found.');
  fs.copyFileSync(source, dest); fs.chmodSync(dest, 0o600);
}
export async function capturePreview(root, {settings = localSettings(root), checkWallet = true} = {}) {
  const staging = path.join(root, '.veylo-cloud'); fs.mkdirSync(staging, {recursive: true, mode: 0o700});
  const directory = fs.mkdtempSync(path.join(staging, 'preview-snapshot-'));
  fs.chmodSync(directory, 0o700);
  try {
    const statePath = path.join(settings.data, 'state.json'), before = fs.readFileSync(statePath);
    const keys = fs.readFileSync(path.join(settings.wallet, 'keys.toml'));
    if (!/^network\s*=\s*"test"\s*$/m.test(keys.toString())) throw plainError('Only the existing Zcash testnet wallet can be imported.');
    fs.mkdirSync(path.join(directory, 'data'), {mode: 0o700});
    fs.writeFileSync(path.join(directory, 'data/state.json'), before, {mode: 0o600});
    if (fs.existsSync(path.join(settings.data, 'assets'))) copyTree(path.join(settings.data, 'assets'), path.join(directory, 'data/assets'));
    fs.mkdirSync(path.join(directory, 'wallet'), {mode: 0o700});
    fs.writeFileSync(path.join(directory, 'wallet/keys.toml'), keys, {mode: 0o600});
    await backupSqlite(path.join(settings.wallet, 'data.sqlite'), path.join(directory, 'wallet/data.sqlite'));
    await backupSqlite(path.join(settings.wallet, 'blockmeta.sqlite'), path.join(directory, 'wallet/blockmeta.sqlite'));
    if (fs.existsSync(path.join(settings.wallet, 'blocks'))) copyTree(path.join(settings.wallet, 'blocks'), path.join(directory, 'wallet/blocks'));
    if (!before.equals(fs.readFileSync(statePath)) || !keys.equals(fs.readFileSync(path.join(settings.wallet, 'keys.toml')))) throw plainError('Local data changed during the snapshot. Run the same preview command again when no checkout or refund is running.');
    const summary = validateState(JSON.parse(before), path.join(directory, 'data/assets'));
    if (checkWallet) {
      const checked = await run(settings.binary, ['wallet', '-w', path.join(directory, 'wallet'), 'get-info', '--server', 'zecrocks'], {timeout: 30000});
      const info = JSON.parse(checked.stdout);
      if (info.chain_name !== 'test' || !Number.isSafeInteger(info.chain_tip_height) || !checked.stderr.includes('WALLET_BRANCH: Nu7 (77190ad9)') || !/SERVER_BRANCH: (?:0x)?77190ad9/i.test(checked.stderr)) throw plainError('The wallet and current testnet branches do not agree. No cloud import was made.');
      // list-accounts contains private viewing keys. Its output is only inspected here.
      const accounts = await run(settings.binary, ['wallet', '-w', path.join(directory, 'wallet'), 'list-accounts'], {timeout: 30000});
      if (!accounts.stdout.split(/\r?\n/).some(line => line.startsWith('Account ' + settings.VEYLO_SELLER_ACCOUNT + ' (birthday height '))) throw plainError('The configured account was not found in the copied wallet.');
      summary.chainTipHeight = info.chain_tip_height;
    }
    const operatorFile = path.join(staging, 'operator.json');
    let operator;
    if (fs.existsSync(operatorFile)) operator = JSON.parse(fs.readFileSync(operatorFile));
    else {operator = {schema: 1, issuerFingerprint: summary.issuerFingerprint, sellerCode: settings.VEYLO_SELLER_CODE?.length >= 12 ? settings.VEYLO_SELLER_CODE : randomBytes(24).toString('hex')}; fs.writeFileSync(operatorFile, JSON.stringify(operator), {mode: 0o600, flag: 'wx'});}
    if (operator.schema !== 1 || operator.issuerFingerprint !== summary.issuerFingerprint || typeof operator.sellerCode !== 'string' || operator.sellerCode.length < 12) throw plainError('The existing private operator configuration does not match this merchant. Preserve it and paste this error.');
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({schema: 1, paymentMode: 'testnet', account: settings.VEYLO_SELLER_ACCOUNT, sellerCode: operator.sellerCode, active: false}), {mode: 0o600});
    const files = captureCloudFiles(directory);
    if (files.has('identity.txt')) throw plainError('A Preview must not contain a wallet signing identity.');
    summary.files = files.size; summary.bytes = [...files.values()].reduce((n, b) => n + b.length, 0);
    return {directory, files, summary};
  } catch (error) {fs.rmSync(directory, {recursive: true, force: true}); throw error;}
}

export async function importPreview(vault, files) {
  if (vault.scope !== 'preview' || files.has('identity.txt')) throw plainError('This command can only import an identity-free Preview. Production data was not changed.');
  const config = JSON.parse(files.get('config.json'));
  if (config.active !== false || config.paymentMode !== 'testnet') throw plainError('Preview sending must be disabled.');
  const lease = await vault.acquire(); const stop = vault.startHeartbeat(lease);
  try {
    const old = await vault.readFiles(lease);
    if (old.has('data/state.json') && JSON.parse(old.get('data/state.json')).publicKey?.x !== JSON.parse(files.get('data/state.json')).publicKey?.x) throw plainError('This Preview belongs to another merchant. It was preserved.');
    const saved = await vault.checkpoint(lease, files);
    return saved;
  } finally {stop(); await vault.release(lease);}
}

function secrets(root) {
  const file = path.join(root, '.env.cloud');
  const value = parseEnv(fs.readFileSync(file, 'utf8'));
  if (!/^[a-f0-9]{64}$/i.test(value.VEYLO_CLOUD_KEY || '') || !value.TURSO_DATABASE_URL || !value.TURSO_AUTH_TOKEN) throw plainError('The existing private cloud configuration is incomplete. Preserve .env.cloud.');
  fs.chmodSync(file, 0o600);
  return value;
}
async function vercel(root, args, input) {
  try {return await run('npx', ['--yes', 'vercel@' + VERCEL_VERSION, ...args, '--scope', SCOPE, '--cwd', root, '--no-color'], {
    cwd: root, input, timeout: 120000, env: {...process.env, NO_UPDATE_NOTIFIER: '1', VERCEL_TELEMETRY_DISABLED: '1', NO_COLOR: '1'},
  });} catch (error) {error.vercel = true; throw error;}
}
export function validateProject(link, remote) {
  const project = remote.project || remote;
  if (!link.projectId || !link.orgId || project.id !== link.projectId || project.name !== PROJECT || project.accountId !== link.orgId) throw plainError('The linked Vercel project does not match the existing Veylo project. No environment variables were changed.');
  if (project.link?.type !== 'github' || project.link.org !== 'theeagle2407' || project.link.repo !== 'veylo' || project.link.productionBranch !== 'main') throw plainError('The Vercel Git integration or production branch needs checking before this Preview can be published.');
  return project;
}
async function checkProject(root) {
  const link = JSON.parse(fs.readFileSync(path.join(root, '.vercel/project.json')));
  if (!/^prj_[A-Za-z0-9]+$/.test(link.projectId || '')) throw plainError('The local Vercel project link is invalid.');
  const inspected = await vercel(root, ['api', '/v9/projects/' + link.projectId, '--method', 'GET', '--raw']);
  return validateProject(link, JSON.parse(inspected.stdout));
}

const PUBLIC_FILES = ['.gitignore', '.vercelignore', 'vercel.json', 'package.json', 'package-lock.json', 'server.mjs', 'payments.mjs', 'merchant.mjs',
  'cloud-state.mjs', 'cloud-runtime.mjs', 'public/cloud-transport.mjs', 'scripts/setup-cloud-storage.mjs', 'scripts/cloud-migration.mjs',
  'api/index.mjs', 'test/cloud-app.test.mjs', 'test/cloud-state.test.mjs', 'test/cloud-runtime.test.mjs', 'test/cloud-migration.test.mjs'];

export async function main(command, root = ROOT) {
  assertPrivatePaths(root);
  const settings = secrets(root);
  if (command === 'preview') {
    phase = 'copying and validating the existing testnet wallet';
    console.log('Creating a private, read-only SQLite backup. Existing wallet files are preserved.');
    const snapshot = await capturePreview(root);
    const client = cloudClient(settings);
    try {
      phase = 'uploading the encrypted Preview';
      const previewKey = previewRuntimeKey(settings.VEYLO_CLOUD_KEY);
      const vault = new CloudVault(client, previewKey, {scope: 'preview'});
      const saved = await importPreview(vault, snapshot.files);
      phase = 'verifying the imported Preview through another connection';
      const verify = new CloudVault(cloudClient(settings), previewKey, {scope: 'preview'});
      let lease;
      try {
        lease = await verify.acquire(); const restored = await verify.readFiles(lease);
        if (restored.size !== snapshot.files.size || [...snapshot.files].some(([name, b]) => !restored.get(name)?.equals(b))) throw plainError('Imported data did not survive a fresh cloud connection. Keep the current backend running.');
      } finally {if (lease) await verify.release(lease); verify.client.close();}
      const report = {ok: true, ...snapshot.summary, revision: saved.revision, separateConnectionVerified: true, previewKeySeparated: true, signingIdentityUploaded: false, transactionsSent: 0, productionChanged: false};
      fs.writeFileSync(path.join(root, '.veylo-cloud/preview-report.json'), JSON.stringify(report, null, 2), {mode: 0o600});
      console.log(JSON.stringify(report, null, 2));
      console.log('PRIVATE PREVIEW IMPORT PASSED. Your submitted app still uses the current backend.');
    } finally {client.close(); fs.rmSync(snapshot.directory, {recursive: true, force: true});}
    return;
  }
  if (command === 'code') {
    const operator = JSON.parse(fs.readFileSync(path.join(root, '.veylo-cloud/operator.json')));
    if (process.platform !== 'darwin') throw plainError('Run this clipboard command on your Mac.');
    await run('/usr/bin/pbcopy', [], {input: operator.sellerCode, cwd: root});
    console.log('Private cloud seller code copied. Paste it into the Preview’s Existing store operator access-code field. Do not paste it into this chat.');
    return;
  }
  if (command === 'configure-preview') {
    phase = 'verifying the existing Vercel project';
    await checkProject(root);
    const values = {TURSO_DATABASE_URL: settings.TURSO_DATABASE_URL, TURSO_AUTH_TOKEN: settings.TURSO_AUTH_TOKEN, VEYLO_CLOUD_KEY: previewRuntimeKey(settings.VEYLO_CLOUD_KEY), VEYLO_CLOUD_MODE: 'scan', VEYLO_PUBLIC_ORIGIN: PUBLIC_ORIGIN};
    for (const [name, value] of Object.entries(values)) {
      phase = 'configuring Preview variable ' + name;
      await vercel(root, ['env', 'add', name, 'preview', '--git-branch', BRANCH, '--type', 'secret', '--force', '--yes'], value);
      console.log('Configured ' + name + ' for the migration Preview; value kept private.');
    }
    fs.writeFileSync(path.join(root, '.veylo-cloud/preview-configured.json'), JSON.stringify({project: PROJECT, branch: BRANCH, at: new Date().toISOString()}), {mode: 0o600});
    console.log('PREVIEW ENVIRONMENT CONFIGURED. Production environment variables were not changed.');
    return;
  }
  if (command === 'publish-preview') {
    phase = 'verifying the migration branch before publishing';
    const configured = JSON.parse(fs.readFileSync(path.join(root, '.veylo-cloud/preview-configured.json')));
    const report = JSON.parse(fs.readFileSync(path.join(root, '.veylo-cloud/preview-report.json')));
    if (!report.ok || configured.project !== PROJECT || configured.branch !== BRANCH) throw plainError('Complete the Preview import and configuration before publishing.');
    await checkProject(root);
    const remote = git(root, ['remote', 'get-url', 'origin']);
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:)theeagle2407\/veylo(?:\.git)?$/.test(remote)) throw plainError('The Git remote does not match the existing Veylo repository. Nothing was pushed.');
    const staged = git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    if (staged.some(name => !PUBLIC_FILES.includes(name))) throw plainError('Unrelated files are already staged. Nothing was committed or pushed. Paste this message back.');
    console.log('Running all tests before publishing the migration branch...');
    await new Promise((resolve, reject) => {const child = spawn('npm', ['test'], {cwd: root, stdio: 'inherit'}); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(plainError('Tests failed. No commit or push was made.')));});
    git(root, ['add', '--', ...PUBLIC_FILES]);
    assertPrivatePaths(root); git(root, ['diff', '--cached', '--check']);
    const names = git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    if (names.some(name => !PUBLIC_FILES.includes(name))) throw plainError('The staged file check failed. Nothing was pushed.');
    if (names.length) git(root, ['commit', '-m', 'Run Veylo on Vercel with encrypted cloud state']);
    execFileSync('git', ['push', '-u', 'origin', BRANCH], {cwd: root, stdio: 'inherit'});
    console.log('MIGRATION PREVIEW PUSHED. Vercel will build this branch. The submitted production URL is unchanged.');
    return;
  }
  throw plainError('Use: preview, configure-preview, publish-preview, or code.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv[2]).catch(error => {
    let privateValues = [];
    try {privateValues = Object.values(secrets(ROOT));} catch {}
    try {privateValues.push(previewRuntimeKey(secrets(ROOT).VEYLO_CLOUD_KEY));} catch {}
    try {privateValues.push(JSON.parse(fs.readFileSync(path.join(ROOT, '.veylo-cloud/operator.json'))).sellerCode);} catch {}
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : Number.isInteger(error.code) ? 'process exit ' + error.code : 'CHECK_FAILED';
    const text = error.safe ? error.message : error.vercel ? error.stderr || 'Vercel command did not finish.' : 'Private check failed while ' + phase + ' (' + code + (error.killed ? ', timeout' : '') + '). No private subprocess output was printed.';
    console.error('STOPPED:', redact(text, privateValues));
    console.error('The submitted URL was not changed. Keep .env.cloud and the original wallet files private.');
    process.exitCode = 1;
  });
}
