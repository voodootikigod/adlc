#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, cpSync, renameSync, rmSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0] || 'install';

/** The directory name the agent CLI will adopt for the installed plugin. */
const PLUGIN_NAME = 'adlc-gemini';

/**
 * Wall-clock bound on every agent subprocess.
 */
const AGY_TIMEOUT_DEFAULT_MS = 120_000;

function resolveAgyTimeoutMs(configured) {
  if (configured === undefined || configured === '') return AGY_TIMEOUT_DEFAULT_MS;
  const raw = Number(configured);
  if (!Number.isFinite(raw) || raw <= 0) {
    console.error(
      `ADLC_AGY_TIMEOUT_MS must be a positive, finite number of milliseconds; got "${configured}".`,
    );
    process.exit(1);
  }
  return raw;
}

const AGY_TIMEOUT_MS = resolveAgyTimeoutMs(process.env.ADLC_AGY_TIMEOUT_MS);

/** Grace between SIGTERM and SIGKILL. */
const AGY_GRACE_MS = 2_000;

/** Children currently running, and staging dirs to remove if we are interrupted. */
const activeChildren = new Set();
const activeStages = new Set();

function signalPidGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function signalGroup(child, signal) {
  signalPidGroup(child.pid, signal);
}

let interruptSignal = null;

function failureExitStatus() {
  if (!interruptSignal) return 1;
  return interruptSignal === 'SIGINT' ? 130 : 143;
}

let shuttingDown = false;
let cancellationDone = null;

function onInterrupt(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  interruptSignal = signal;

  const groups = [...activeChildren].map((child) => child.pid);
  for (const pid of groups) signalPidGroup(pid, 'SIGTERM');

  cancellationDone = new Promise((resolveCancellation) => {
    setTimeout(() => {
      for (const pid of groups) signalPidGroup(pid, 'SIGKILL');
      for (const stage of activeStages) {
        try {
          rmSync(stage, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
      resolveCancellation();
    }, AGY_GRACE_MS);
  });

  cancellationDone.then(() => process.exit(failureExitStatus()));
}
process.on('SIGINT', () => onInterrupt('SIGINT'));
process.on('SIGTERM', () => onInterrupt('SIGTERM'));

function runBounded(command, args, { inherit = false } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { stdio: inherit ? 'inherit' : 'ignore', detached: true });
    } catch (error) {
      resolvePromise({ status: null, error });
      return;
    }
    activeChildren.add(child);

    let timedOut = false;
    let killTimer;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      activeChildren.delete(child);
      resolvePromise(result);
    };

    const termTimer = setTimeout(() => {
      timedOut = true;
      signalGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup(child, 'SIGKILL');
        settle({
          status: null,
          error: new Error(
            `timed out after ${AGY_TIMEOUT_MS}ms` +
              ' — raise the bound with ADLC_AGY_TIMEOUT_MS=<milliseconds> if this install is legitimately slow',
          ),
        });
      }, AGY_GRACE_MS);
    }, AGY_TIMEOUT_MS);

    child.on('error', (error) => settle({ status: null, error }));
    child.on('exit', (code) => {
      if (timedOut || shuttingDown) return;
      settle({ status: code });
    });
  });
}

/**
 * Resolve the agent binaries to ABSOLUTE paths, ignoring npm-injected bin dirs.
 *
 * @param {string[]} targets Binary names to search for (e.g. ['agy', 'jetski']).
 * @returns {{path: string, name: string}[]} absolute paths and names of agent binaries found.
 */
function resolveAgentBins(targets) {
  const npmInjected = join('node_modules', '.bin');
  const resolved = [];
  const seenPaths = new Set();
  const seenNames = new Set();
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())
    : [''];

  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (!isAbsolute(dir)) continue;
    const normalized = dir.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    if (normalized.endsWith('node_modules/.bin') || normalized.endsWith('node-gyp-bin')) continue;
    for (const name of targets) {
      if (seenNames.has(name)) continue;
      for (const ext of extensions) {
        const candidate = join(dir, name + ext);
        if (seenPaths.has(candidate)) continue;
        try {
          const stat = statSync(candidate);
          if (stat.isFile()) {
            accessSync(candidate, constants.X_OK);
            resolved.push({ path: candidate, name });
            seenPaths.add(candidate);
            seenNames.add(name);
            break;
          }
        } catch {
          // keep looking
        }
      }
    }
  }
  return resolved;
}

/**
 * Run agent plugin install against a staged copy of the plugin.
 *
 * @param {string} sourceDir Plugin directory to install from.
 * @param {{path: string, name: string}} agentBin Resolved agent binary.
 * @returns {number | null} exit status, or null if staging/execution failed.
 */
async function agentInstallFromStagedCopy(sourceDir, agentBin) {
  let stage;
  try {
    let root = tmpdir();
    if (root.includes('@')) {
      root = process.platform === 'win32' ? join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'tmp') : '/tmp';
    }
    mkdirSync(root, { recursive: true });
    stage = mkdtempSync(join(root, 'adlc-gemini-'));
    activeStages.add(stage);
    if (stage.includes('@')) {
      throw new Error(`no @-free temporary directory available (tried ${root})`);
    }
    cpSync(sourceDir, join(stage, PLUGIN_NAME), { recursive: true });
    const result = await runBounded(agentBin.path, ['plugin', 'install', join(stage, PLUGIN_NAME)], {
      inherit: true,
    });
    if (result.error) {
      console.error(`\`${agentBin.name} plugin install\` did not complete: ${result.error.message}`);
      return null;
    }
    return result.status;
  } catch (err) {
    console.error(`Failed to stage the plugin for ${agentBin.name}: ${err.message}`);
    return null;
  } finally {
    if (stage) {
      activeStages.delete(stage);
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

async function exitAfterCancellation(code) {
  if (cancellationDone) await cancellationDone;
  process.exit(code);
}

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`
ADLC Google Gemini Plugin Helper

Usage:
  adlc-gemini install     Install when @adlc/gemini is installed globally
  adlc-gemini --help      Display this help message

  Recommended one-liner (neutral cwd keeps a hostile repo's .npmrc and
  node_modules out of the resolution):
    (cd "$(mktemp -d)" && npx @adlc/gemini@latest install)

Environment:
  ADLC_AGY_TIMEOUT_MS   Wall-clock bound on each agent subprocess, in
                        milliseconds. Default 120000. Must be a positive,
                        finite number. Raise it if install is slow.

Description:
  Registers the @adlc/gemini plugin with Google Antigravity (agy) or JetSki (jetski).
  First attempts to run \`[agent] plugin install <path>\` using the detected binary.
  If neither is found, copies the plugin to ~/.gemini/config/plugins/adlc-gemini.
`);
  process.exit(0);
}

if (command === 'install' || command === '--install') {
  console.log(`Installing @adlc/gemini plugin from: ${packageRoot}`);

  const pluginsDir = join(homedir(), '.gemini', 'config', 'plugins');
  const legacyDir = join(pluginsDir, 'adlc-antigravity');
  if (existsSync(legacyDir)) {
    console.log(`Detected legacy Antigravity plugin directory at ${legacyDir}. Cleaning it up...`);
    try {
      rmSync(legacyDir, { recursive: true, force: true });
      console.log('✓ Legacy Antigravity plugin directory removed.');
    } catch (err) {
      console.warn(`Warning: Failed to clean up legacy directory ${legacyDir}: ${err.message}`);
    }
  }

  const basename = process.argv[1] ? process.argv[1].split(/[\\/]/).pop() : '';
  let targets = ['agy', 'jetski'];
  if (basename.includes('adlc-agy') || basename.includes('adlc-antigravity')) {
    targets = ['agy'];
  } else if (basename.includes('adlc-jetski')) {
    targets = ['jetski'];
  }

  const agentBins = resolveAgentBins(targets);
  if (agentBins.length > 0) {
    let installedAny = false;
    let hasFailure = false;
    for (const agentBin of agentBins) {
      if (interruptSignal) break;
      const probe = await runBounded(agentBin.path, ['--version']);
      if (probe.status !== 0) {
        console.error(`Found ${agentBin.name} at ${agentBin.path}, but \`${agentBin.name} --version\` failed${probe.error ? `: ${probe.error.message}` : ` (exit ${probe.status})`}.`);
        console.error(`Skipping ${agentBin.name} registration.`);
        hasFailure = true;
        continue;
      }

      console.log(`Google Gemini (${agentBin.name}) detected. Running ${agentBin.name} plugin install...`);
      const status = await agentInstallFromStagedCopy(packageRoot, agentBin);
      if (status === 0) {
        console.log(`✓ Successfully installed @adlc/gemini plugin via ${agentBin.name}!`);
        installedAny = true;
      } else {
        console.error(
          status === null
            ? `\`${agentBin.name} plugin install\` did not complete — see the reason above.`
            : `\`${agentBin.name} plugin install\` failed (exit ${status}); see ${agentBin.name}'s output above.`,
        );
        hasFailure = true;
      }
    }
    if (installedAny && !hasFailure && !interruptSignal) {
      await exitAfterCancellation(0);
    } else {
      console.error(
        interruptSignal
          ? 'Installation was interrupted.'
          : hasFailure
          ? 'Registration failed for one or more detected hosts. Not falling back to a direct copy.'
          : 'Not falling back to a direct copy: hosts are present but registration failed.'
      );
      await exitAfterCancellation(failureExitStatus());
    }
  }

  const targetDir = join(pluginsDir, PLUGIN_NAME);

  console.log(`Copying plugin files directly to ${targetDir}...`);
  const incoming = `${targetDir}.incoming-${process.pid}`;
  const previous = `${targetDir}.previous-${process.pid}`;
  let movedAside = false;
  try {
    mkdirSync(pluginsDir, { recursive: true });
    rmSync(incoming, { recursive: true, force: true });
    cpSync(packageRoot, incoming, { recursive: true });
    if (existsSync(targetDir)) {
      renameSync(targetDir, previous);
      movedAside = true;
    }
    renameSync(incoming, targetDir);
    if (movedAside) rmSync(previous, { recursive: true, force: true });
    console.log(`✓ Plugin copied to ${targetDir}`);
    console.log('Note: Run `/adlc-init` inside your agent session to complete setup.');
    await new Promise((resolveTick) => setImmediate(resolveTick));
    await exitAfterCancellation(interruptSignal ? failureExitStatus() : 0);
  } catch (err) {
    rmSync(incoming, { recursive: true, force: true });
    if (movedAside && !existsSync(targetDir)) renameSync(previous, targetDir);
    console.error(`Failed to copy plugin files to ${targetDir}:`, err.message);
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run `adlc-gemini --help` for available commands.');
  process.exit(1);
}
