import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const root = process.cwd();
const source = path.join(root, 'tools/nu7-wallet');
const build = path.join(root, '.veylo-cloud-build');
const output = path.join(root, 'cloud-bin');
const toolchain = '1.97.1';

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'inherit', ...options});
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Build step failed: ${path.basename(command)} (${signal || code}).`));
    });
  });
}

async function download(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(`Official tool download returned HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

try {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('This build runs on Vercel Linux x64, not on your Mac.');
  }
  const cargoToml = await fs.readFile(path.join(source, 'Cargo.toml'), 'utf8');
  const branchTest = await fs.readFile(path.join(source, 'src/commands/wallet/get_info.rs'), 'utf8');
  await fs.access(path.join(source, 'Cargo.lock'));
  if (!cargoToml.includes('vendor/zcash_protocol') || !branchTest.includes('0x77190ad9')) {
    throw new Error('The preserved Veylo NU7 wallet source is missing or differs from the expected source.');
  }
  await fs.mkdir(build, {recursive: true});
  await fs.mkdir(output, {recursive: true});
  const cargoHome = path.join(build, 'cargo');
  const rustupHome = path.join(build, 'rustup');
  const env = {
    ...process.env,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
    CARGO_TARGET_DIR: path.join(build, 'target'),
    CARGO_BUILD_JOBS: '2',
    RUSTFLAGS: '--cfg zcash_unstable="nu7"',
    CARGO_PROFILE_RELEASE_STRIP: 'symbols',
    CARGO_PROFILE_RELEASE_DEBUG: '0',
    RUSTUP_INIT_SKIP_PATH_CHECK: 'yes',
    NO_COLOR: '1',
  };
  delete env.CARGO_ENCODED_RUSTFLAGS;
  const cargo = path.join(cargoHome, 'bin/cargo');
  let installed = true;
  try { await fs.access(cargo); } catch { installed = false; }
  if (!installed) {
    console.log('Installing the pinned compiler in the build container. No wallet data is used.');
    const url = 'https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init';
    const bytes = await download(url);
    const checksum = (await download(`${url}.sha256`)).toString('utf8').trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(checksum) || createHash('sha256').update(bytes).digest('hex') !== checksum) {
      throw new Error('The official compiler installer checksum did not match.');
    }
    const installer = path.join(build, 'rustup-init');
    await fs.writeFile(installer, bytes, {mode: 0o700});
    await run(installer, ['-y', '--profile', 'minimal', '--default-toolchain', toolchain, '--no-modify-path'], {env});
  }
  console.log('Running the preserved NU7 test, then building the wallet executable.');
  const common = ['--locked', '--release', '--features', 'rusqlite/bundled'];
  await run(cargo, [`+${toolchain}`, 'test', ...common, 'veylo_nu7', '--', '--nocapture'], {cwd: source, env});
  await run(cargo, [`+${toolchain}`, 'build', ...common], {cwd: source, env});
  const binary = path.join(output, 'zcash-devtool');
  await fs.copyFile(path.join(build, 'target/release/zcash-devtool'), binary);
  await fs.chmod(binary, 0o755);
  const stat = await fs.stat(binary);
  if (stat.size > 200 * 1048576) throw new Error('The wallet binary is too large for this conservative function bundle limit.');
  const bytes = await fs.readFile(binary);
  await fs.writeFile(path.join(output, 'build-info.json'), JSON.stringify({
    toolchain,
    architecture: 'linux-x64',
    binaryBytes: stat.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    nu7TestPassed: true,
    sqliteBundled: true,
  }, null, 2) + '\n');
  console.log(`VEYLO WALLET BUILD COMPLETE — ${(stat.size / 1048576).toFixed(2)} MiB. No wallet or identity was opened.`);
} catch (error) {
  console.error(`VEYLO CLOUD BUILD STOPPED: ${error.message}`);
  process.exitCode = 1;
}
