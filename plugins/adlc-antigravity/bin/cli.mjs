#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0] || 'install';

/** The directory name agy will adopt for the installed plugin. */
const PLUGIN_NAME = 'adlc-antigravity';

/**
 * Run `agy plugin install` against a copy of the plugin placed under a path
 * containing no `@`.
 *
 * agy resolves its target as `plugin@marketplace` BEFORE deciding whether it is
 * a filesystem path, so an `@` ANYWHERE in the argument is taken as that
 * separator. Every location npm gives a scoped package has one: handed
 * `.../node_modules/@adlc/antigravity` directly, agy reports
 * `unknown marketplace: adlc/antigravity` and never looks at the disk.
 *
 * Staging is safe because agy COPIES the directory into
 * `~/.gemini/config/plugins/<name>/` — the installed plugin does not keep a
 * reference to the source, so the staging directory is disposable.
 *
 * @param {string} sourceDir Plugin directory to install from.
 * @returns {number | null} agy's exit status, or null if staging failed.
 */
function agyInstallFromStagedCopy(sourceDir) {
  let stage;
  try {
    // os.tmpdir() honours TMPDIR, which is NOT guaranteed to be @-free — a
    // TMPDIR of /var/tmp/user@example.com would stage under a path carrying the
    // exact character this whole function exists to avoid. Fall back to /tmp,
    // which cannot contain one; if that is unusable, fail loudly rather than
    // handing agy an argument it is certain to misparse.
    let root = tmpdir();
    if (root.includes('@')) root = '/tmp';
    stage = mkdtempSync(join(root, 'adlc-agy-'));
    if (stage.includes('@')) {
      throw new Error(`no @-free temporary directory available (tried ${root})`);
    }
    cpSync(sourceDir, join(stage, PLUGIN_NAME), { recursive: true });
  } catch (err) {
    console.error(`Failed to stage the plugin for agy: ${err.message}`);
    if (stage) rmSync(stage, { recursive: true, force: true });
    return null;
  }
  try {
    const result = spawnSync('agy', ['plugin', 'install', join(stage, PLUGIN_NAME)], {
      stdio: 'inherit',
    });
    return result.status;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`
ADLC Google Antigravity Plugin Helper

Usage:
  npx @adlc/antigravity install    Install and register the ADLC plugin with agy
  adlc-agy install                 Install when @adlc/antigravity is installed globally
  adlc-agy --help                  Display this help message

  Note: "npx adlc-agy" does NOT work — adlc-agy is a bin name, not a package
  name, so npx would look for an unpublished package by that name.

Description:
  Registers the @adlc/antigravity plugin with Google Antigravity (agy).
  First attempts to run \`agy plugin install <path>\`. If agy is not found,
  copies the plugin to ~/.gemini/config/plugins/adlc-antigravity.
`);
  process.exit(0);
}

if (command === 'install' || command === '--install') {
  console.log(`Installing @adlc/antigravity plugin from: ${packageRoot}`);

  let agyInstalled = false;
  try {
    const res = spawnSync('agy', ['--version'], { encoding: 'utf8' });
    if (res.status === 0) {
      agyInstalled = true;
    }
  } catch {
    agyInstalled = false;
  }

  if (agyInstalled) {
    console.log('Google Antigravity (agy) detected. Running agy plugin install...');
    const status = agyInstallFromStagedCopy(packageRoot);
    if (status === 0) {
      console.log('✓ Successfully installed @adlc/antigravity plugin via agy!');
      process.exit(0);
    } else {
      console.error('⚠️ `agy plugin install` returned non-zero status.');
    }
  }

  // Fallback / manual placement into plugin dir
  const targetDir = join(homedir(), '.gemini', 'config', 'plugins', 'adlc-antigravity');
  console.log(`Copying plugin files directly to ${targetDir}...`);
  try {
    mkdirSync(targetDir, { recursive: true });
    cpSync(packageRoot, targetDir, { recursive: true });
    console.log(`✓ Plugin copied to ${targetDir}`);
    console.log('Note: Run `/adlc-init` inside your agent session to complete setup.');
    process.exit(0);
  } catch (err) {
    console.error(`Failed to copy plugin files to ${targetDir}:`, err.message);
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run `npx @adlc/antigravity --help` for available commands.');
  process.exit(1);
}
