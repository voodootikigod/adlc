import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTool } from './registry.mjs';

const require = createRequire(import.meta.url);

export function packageJsonPath(packageName) {
  if (packageName.startsWith('@adlc/')) {
    const name = packageName.slice('@adlc/'.length);
    const devPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', name, 'package.json');
    if (existsSync(devPath)) {
      try {
        const pkg = JSON.parse(readFileSync(devPath, 'utf8'));
        if (pkg?.name === packageName) return devPath;
      } catch {
        /* fall through to require.resolve */
      }
    }
  }
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }
}

function resolvePackageBin(packageName, binName) {
  const pkgJsonPath = packageJsonPath(packageName);
  if (!pkgJsonPath) return null;
  return binPathFromPackage(pkgJsonPath, readPackage(pkgJsonPath), binName);
}

function readPackage(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function binPathFromPackage(pkgJsonPath, pkg, preferredBinName) {
  const bin = pkg?.bin;
  if (!bin) return null;
  if (typeof bin === 'string') return join(dirname(pkgJsonPath), bin);
  const name = preferredBinName ?? Object.keys(bin)[0];
  const relative = bin[name];
  return relative ? join(dirname(pkgJsonPath), relative) : null;
}

export function resolveBin(toolName) {
  const tool = getTool(toolName);
  if (!tool) return null;
  const pkgJsonPath = packageJsonPath(tool.packageName);
  if (!pkgJsonPath) return null;
  const pkg = readPackage(pkgJsonPath);
  return binPathFromPackage(pkgJsonPath, pkg, tool.binName ?? tool.name);
}

export function resolveRunnerBin() {
  const pkgJsonPath = packageJsonPath('@adlc/runner');
  if (!pkgJsonPath) return null;
  const pkg = readPackage(pkgJsonPath);
  return binPathFromPackage(pkgJsonPath, pkg, 'adlc-runner') ?? binPathFromPackage(pkgJsonPath, pkg);
}

// Signals forwarded to the tool child. SIGKILL is absent because it cannot be
// caught here any more than anywhere else.
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Run a tool as a child and FORWARD termination signals to it.
 *
 * This used to be spawnSync, which cannot forward anything: while the parent is
 * blocked in spawnSync, Node cannot dispatch a signal handler at all, and no
 * handler was registered in any case. Kill the `adlc` process by pid — which is
 * what a tool timeout, a CI cancellation or a supervisor does — and the wrapper
 * died while the tool kept running, orphaned.
 *
 * That is not a cosmetic leak. `adlc hollow-test` mutates source files in place;
 * an orphaned run keeps mutating a tree whose owner believes the command is over,
 * and its own careful SIGINT handler never fires because the signal was delivered
 * to the wrapper instead. Interactive Ctrl-C hid this, because a terminal sends
 * the signal to the whole foreground process group and both processes got it.
 *
 * Exit-code semantics are deliberately UNCHANGED: a child killed by a signal
 * still reports code 1 with a "terminated by signal" message, exactly as the
 * spawnSync shape did. Distinguishing cancellation (130/143) from failure is a
 * real improvement but a separate, wider behaviour change.
 */
function runChild(label, spawnFn, command, args, failPrefix) {
  return new Promise((settle) => {
    let child;
    try {
      child = spawnFn(command, args, { stdio: 'inherit' });
    } catch (err) {
      settle({ code: 1, error: `${failPrefix}: ${err.message}` });
      return;
    }

    const handlers = FORWARDED_SIGNALS.map((signal) => [
      signal,
      () => {
        try {
          child.kill(signal);
        } catch { /* already gone — nothing to forward to */ }
      },
    ]);
    for (const [signal, handler] of handlers) process.on(signal, handler);

    // Removed on settle: `adlc` is long-lived enough in tests and embedders that
    // leaving a listener per dispatch would leak and eventually warn.
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      settle(result);
    };

    child.on('error', (err) => finish({ code: 1, error: `${failPrefix}: ${err.message}` }));
    child.on('exit', (status, signal) => {
      if (signal) finish({ code: 1, error: `${label} terminated by signal ${signal}` });
      else finish({ code: typeof status === 'number' ? status : 1 });
    });
  });
}

function runBin(label, bin, args, spawnFn) {
  if (!bin) {
    return Promise.resolve({
      code: 1,
      error: `tool not installed: ${label} - run "npm i -g @adlc/cli" to install the suite`,
    });
  }

  return runChild(label, spawnFn, process.execPath, [bin, ...args], `failed to run ${label}`);
}

// External verbs (registry.mjs `external: true`) are not workspace packages, so there is
// no local bin to resolve. They shell out to `npx <packageName>` with full argument
// passthrough instead -- this is how `adlc review` reaches the separate
// `adversarial-review` CLI without vendoring it into this monorepo (issue #65).
function runExternal(packageName, args, spawnFn) {
  return runChild(
    packageName,
    spawnFn,
    'npx',
    [packageName, ...args],
    `failed to run npx ${packageName}`,
  );
}

export function dispatch(toolName, args, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawn;
  const tool = getTool(toolName);
  if (toolName === 'ticket' && ['pull', 'push', 'sync', 'doctor'].includes(args[0])) {
    return runBin('@adlc/ticket-sync', resolvePackageBin('@adlc/ticket-sync', 'adlc-ticket-sync'), args, spawnFn);
  }
  if (tool?.external) {
    return runExternal(tool.packageName, args, spawnFn);
  }
  return runBin(tool?.packageName ?? `@adlc/${toolName}`, resolveBin(toolName), args, spawnFn);
}

export function dispatchRunner(args, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawn;
  return runBin('@adlc/runner', resolveRunnerBin(), args, spawnFn);
}
