import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify, parseEnv} from 'node:util';
import {cloudClient, checkCloudStorage} from '../cloud-state.mjs';

const execute = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const destination = path.join(root, '.env.cloud');
const executable = path.join(os.homedir(), '.turso', 'turso');
let settings;

function redact(value) {
  let result = String(value || 'Setup failed.');
  for (const secret of [settings?.TURSO_AUTH_TOKEN, settings?.VEYLO_CLOUD_KEY]) {
    if (secret) result = result.replaceAll(secret, '[redacted]');
  }
  return result.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]').slice(0, 3000);
}
async function cli(args) {
  const result = await execute(executable, args, {
    cwd: root,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    env: {...process.env, NO_COLOR: '1'},
  });
  return result.stdout.trim();
}

try {
  const branch = (await execute('git', ['branch', '--show-current'], {cwd: root})).stdout.trim();
  if (branch !== 'veylo-cloud-migration') throw Error('Use the veylo-cloud-migration branch.');
  try { await execute('git', ['check-ignore', '-q', '--', '.env.cloud'], {cwd: root}); }
  catch { throw Error('.env.cloud is not ignored by Git. Run the storage installer first.'); }
  const tracked = (await execute('git', ['ls-files', '--', '.env*', 'data', '*.age', '*.key', '*.pem'], {cwd: root})).stdout.trim();
  if (tracked) throw Error('Private-file patterns are tracked by Git. Stop before continuing.');
  try {
    settings = parseEnv(await fs.readFile(destination, 'utf8'));
    if (!/^[a-f0-9]{64}$/i.test(settings.VEYLO_CLOUD_KEY || '')) throw Error('The existing encryption key is invalid. Preserve .env.cloud; do not replace it.');
    console.log('Using the existing private cloud configuration. Its encryption key is preserved.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await fs.access(executable, fs.constants.X_OK); }
    catch { throw Error('Install the official Turso CLI first, then run ~/.turso/turso auth login.'); }
    console.log('Checking the veylo database. Turso credentials will not be printed.');
    let databaseURL;
    try { databaseURL = await cli(['db', 'show', '--url', 'veylo']); }
    catch {
      // The verified CLI default is libSQL. The newer --tursodb engine is intentionally not selected.
      await cli(['db', 'create', 'veylo', '--wait']);
      databaseURL = await cli(['db', 'show', '--url', 'veylo']);
    }
    if (!/^libsql:\/\/[A-Za-z0-9.-]+\.turso\.io\/?$/.test(databaseURL)) {
      throw Error('The veylo database must use the libSQL engine. No private configuration was written.');
    }
    const token = await cli(['db', 'tokens', 'create', 'veylo', '--expiration', 'never']);
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw Error('The CLI did not return the expected database token format. Its output was kept private.');
    }
    settings = {TURSO_DATABASE_URL: databaseURL, TURSO_AUTH_TOKEN: token, VEYLO_CLOUD_KEY: randomBytes(32).toString('hex')};
    const content = Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
    await fs.writeFile(destination, content, {flag: 'wx', mode: 0o600});
    console.log('Saved .env.cloud privately. Keep it: its encryption key will be required to restore cloud data.');
  }
  await fs.chmod(destination, 0o600);
  console.log('Checking encrypted storage through two separate database clients...');
  const result = await checkCloudStorage(() => cloudClient(settings), settings.VEYLO_CLOUD_KEY);
  console.log(JSON.stringify(result, null, 2));
  console.log('CLOUD STORAGE CHECK PASSED. No purchases, wallet files or wallet identities were imported.');
  console.log('The submitted live application still uses the current backend until the next migration batch.');
} catch (error) {
  console.error(`STOPPED: ${redact(error.stderr || error.message)}`);
  console.error('Preserve .env.cloud if it exists. Paste this error output; do not paste that file or any token.');
  process.exitCode = 1;
}
