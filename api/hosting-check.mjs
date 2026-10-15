import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute = promisify(execFile);
let cached;
let pending;

function respond(res, status, value) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.statusCode = status;
  res.end(JSON.stringify(value, null, 2));
}

async function inspect() {
  const started = Date.now();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-hosting-check-'));
  let buildInfo;
  try {
    const binary = path.join(process.cwd(), 'cloud-bin', 'zcash-devtool');
    buildInfo = JSON.parse(await fs.readFile(path.join(process.cwd(), 'cloud-bin', 'build-info.json'), 'utf8'));
    // Public network settings only. No wallet account, seed, identity or viewing key.
    await fs.writeFile(path.join(folder, 'keys.toml'), 'network = "test"\nbirthday = 4465026\n', {mode: 0o600});
    const {stdout, stderr} = await execute(binary, ['wallet', '-w', folder, 'get-info', '--server', 'zecrocks'], {
      timeout: 25000,
      maxBuffer: 65536,
      env: {PATH: process.env.PATH || '/usr/bin:/bin', NO_COLOR: '1'},
    });
    const info = JSON.parse(stdout);
    if (info.chain_name !== 'test' || !Number.isSafeInteger(info.chain_tip_height) || info.chain_tip_height < 4465026) {
      throw new Error('The wallet did not return current testnet metadata.');
    }
    if (!stderr.includes('WALLET_BRANCH: Nu7 (77190ad9)') || !/SERVER_BRANCH: (?:0x)?77190ad9/i.test(stderr)) {
      throw new Error('Wallet and testnet consensus branches could not be confirmed.');
    }
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      build: buildInfo,
      network: 'Zcash testnet',
      chainTipHeight: info.chain_tip_height,
      nu7BranchMatches: true,
      scope: 'Executable and read-only network metadata check only. Payment scanning, spending and persistence have not been tested here.',
      walletSecretsUsed: false,
      transactionsSent: 0,
    };
  } catch (error) {
    // The subprocess received only public settings and no application credentials.
    const details = typeof error.stderr === 'string' ? error.stderr.trim().slice(0, 4000) : '';
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      build: buildInfo || null,
      error: details || (typeof error.code === 'string' ? error.code : error.message),
      timedOut: Boolean(error.killed),
      scope: 'This is a deployment diagnostic, not a payment result.',
      walletSecretsUsed: false,
      transactionsSent: 0,
    };
  } finally {
    await fs.rm(folder, {recursive: true, force: true}).catch(() => {});
  }
}

export default async function handler(req, res) {
  if (!['preview', 'development'].includes(process.env.VERCEL_ENV)) {
    return respond(res, 404, {error: 'Preview diagnostic only.'});
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return respond(res, 405, {error: 'Use GET.'});
  }
  if (!cached || cached.until < Date.now()) {
    pending ??= inspect();
    try {
      const value = await pending;
      cached = {value, until: Date.now() + (value.ok ? 600000 : 15000)};
    } finally { pending = null; }
  }
  return respond(res, cached.value.ok ? 200 : 503, cached.value);
}
