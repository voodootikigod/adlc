#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
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
 * Resolve `agy` to an ABSOLUTE path, ignoring npm-injected bin directories.
 *
 * `npx @adlc/antigravity@latest install` runs through npm exec, which prepends
 * the CURRENT PROJECT's `node_modules/.bin` to the child PATH. A repository that
 * ships a dependency or workspace exposing a bin named `agy` therefore gets its
 * binary executed by this helper the moment it probes `agy --version` — the same
 * local-shadowing attack the `@latest` pin closes for the helper itself, one
 * process level deeper. Verified reproducible: a planted bin ran as `agy`.
 *
 * Dropping npm's bin directories cannot hide a legitimate install: agy is a
 * standalone binary that lives on the real PATH, not an npm package.
 *
 * Only a bare `agy` is looked for, deliberately — no `agy.exe`. This integration
 * is POSIX-only in session (see "Platform notes" in docs/integrations/
 * antigravity.md), so a Windows candidate would be an untested branch supporting
 * a platform the plugin does not claim. Add it together with a Windows test if
 * that ever changes.
 *
 * @returns {string | null} absolute path to agy, or null when it is not present.
 */
function resolveAgyBin() {
  const npmInjected = join('node_modules', '.bin');
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const normalized = dir.replace(/[\\/]+$/, '');
    if (normalized.endsWith(npmInjected) || normalized.endsWith('node-gyp-bin')) continue;
    const candidate = join(dir, 'agy');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here — keep looking
    }
  }
  return null;
}

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
 * @param {string} agyBin Absolute path to agy, from resolveAgyBin().
 * @returns {number | null} agy's exit status, or null if staging failed.
 */
function agyInstallFromStagedCopy(sourceDir, agyBin) {
  // ONE cleanup site, in `finally`. An earlier shape cleaned up in both a catch
  // (staging failed) and a finally (install finished), and the catch copy was
  // unreachable from any test that does not contrive a filesystem failure — so
  // it was two mutable lines with no observer. Collapsing the two paths means
  // every success-path test also exercises the cleanup.
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
    return spawnSync(agyBin, ['plugin', 'install', join(stage, PLUGIN_NAME)], {
      stdio: 'inherit',
    }).status;
  } catch (err) {
    console.error(`Failed to stage the plugin for agy: ${err.message}`);
    return null;
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
}

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`
ADLC Google Antigravity Plugin Helper

Usage:
  npx @adlc/antigravity@latest install    Install and register the ADLC plugin with agy
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

  // Resolved ONCE to an absolute path, with npm's injected bin dirs excluded, and
  // reused for both calls — so a repo-local `agy` cannot hijack either one.
  const agyBin = resolveAgyBin();
  let agyInstalled = false;
  if (agyBin) {
    try {
      const res = spawnSync(agyBin, ['--version'], { encoding: 'utf8' });
      if (res.status === 0) {
        agyInstalled = true;
      }
    } catch {
      agyInstalled = false;
    }
  }

  if (agyInstalled) {
    console.log('Google Antigravity (agy) detected. Running agy plugin install...');
    const status = agyInstallFromStagedCopy(packageRoot, agyBin);
    if (status === 0) {
      console.log('✓ Successfully installed @adlc/antigravity plugin via agy!');
      process.exit(0);
    }
    // FAIL CLOSED when agy is PRESENT and still refused the plugin.
    //
    // The direct copy below exists for a machine with no agy at all — it drops
    // the files where agy would look. Using it to paper over a rejection by an
    // agy that IS installed reports success for an install the authoritative
    // installer declined: a manifest or compatibility error becomes a plugin that
    // was never registered, with the cause buried in scrollback and the exit
    // status saying 0. Automation reading that status cannot tell the difference.
    console.error(
      status === null
        ? '`agy plugin install` was never reached — staging failed (see above).'
        : `\`agy plugin install\` failed (exit ${status}); see agy's output above.`,
    );
    console.error('Not falling back to a direct copy: agy is installed and rejected this plugin.');
    process.exit(1);
  }

  // Fallback for a machine with NO agy: place the files where agy would look.
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
  console.error('Run `npx @adlc/antigravity@latest --help` for available commands.');
  process.exit(1);
}
