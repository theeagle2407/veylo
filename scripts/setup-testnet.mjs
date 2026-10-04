import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const destination = path.join(root, '.env.testnet');
if (fs.existsSync(destination)) {
  console.log('.env.testnet already exists; preserved.');
  process.exit(0);
}
if (!process.stdin.isTTY) {
  console.error('Run this setup in an interactive terminal. No configuration was written.');
  process.exit(1);
}
const home = os.homedir();
const terminal = createInterface({input: process.stdin, output: process.stdout});
const expand = value => path.resolve(value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
try {
  console.log('Configure an existing seller testnet wallet. Do not enter recovery words or private keys.');
  const ask = async (label, fallback = '') => {
    const answer = (await terminal.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim();
    return answer || fallback;
  };
  const binary = expand(await ask('Wallet executable', path.join(home, 'Developer/veylo-zcash-devtool/target/release/zcash-devtool')));
  const wallet = expand(await ask('Seller wallet directory', path.join(home, 'veylo-test-wallets/seller')));
  const identity = expand(await ask('Seller age identity file path', path.join(home, 'veylo-test-wallets/seller.age')));
  const account = await ask('Seller account UUID (from wallet list-accounts)');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account)) throw Error('Invalid account UUID.');
  if (!fs.statSync(binary).isFile()) throw Error('Executable must be a file.');
  fs.accessSync(binary, fs.constants.X_OK);
  if (!fs.statSync(wallet).isDirectory()) throw Error('Wallet must be a directory.');
  if (!fs.statSync(identity).isFile()) throw Error('Identity must be a file.');
  const settings = {
    VEYLO_PAYMENT_MODE: 'testnet',
    VEYLO_WALLET_BINARY: binary,
    VEYLO_SELLER_WALLET: wallet,
    VEYLO_SELLER_IDENTITY: identity,
    VEYLO_SELLER_ACCOUNT: account
  };
  for (const value of Object.values(settings)) if (/[\r\n\0]/.test(value)) throw Error('Invalid configuration value.');
  fs.writeFileSync(destination, Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', {mode: 0o600, flag: 'wx'});
  console.log('Saved local paths and account identifier. Identity contents were not copied.');
  console.log('Start: node --env-file=.env.testnet server.mjs');
} catch (error) {
  console.error(`Setup failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  terminal.close();
}
