import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
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

// Where npm keeps npx-cli.js, relative to the directory holding the running node binary.
// These are the paths npm's OWN shims look in, so they are not guesses:
//
//   npx.cmd (Windows):  SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js"
//   npx     (POSIX):    NPX_CLI_JS="$CLI_BASEDIR/node_modules/npm/bin/npx-cli.js"
//
// where %~dp0 is the install dir the shim shares with node.exe and CLI_BASEDIR is
// literally `dirname(process.execPath)`.
//
// THE TABLE IS PLATFORM-KEYED ON PURPOSE, and the ordering is load-bearing. On a POSIX
// prefix install the shim is reached through a <prefix>/bin/npx symlink into
// <prefix>/lib/node_modules/npm/bin — still inside the install prefix, so probing it is
// safe there. On Windows the same `..` walk lands on a SIBLING of the install dir that
// npm never creates and an unprivileged user often can: an nvm-windows node at
// ...\nvm\v20.11.0\node.exe would probe ...\nvm\lib\node_modules\npm\bin\npx-cli.js.
// Anything found there is by definition not npm's, and we would run it as `node <file>`.
// So win32 probes the install dir and nothing else.
const NPX_CLI_LAYOUTS = {
  win32: [['node_modules', 'npm', 'bin', 'npx-cli.js']],
  posix: [
    ['node_modules', 'npm', 'bin', 'npx-cli.js'],
    ['..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'],
  ],
};

// A candidate must be a NON-EMPTY regular file, and a candidate that is not must fall
// through to the next rung rather than end the search.
//
// Both halves defend the same failure: `adlc review` reporting success with no reviewer
// having run. existsSync is true for DIRECTORIES, and `node <directory>` exits non-zero
// — noisy but survivable. `node <empty file>` exits ZERO, which runChild propagates
// straight out as success. An interrupted npm install that leaves a zero-byte
// npx-cli.js would silently turn the review gate green.
//
// This cannot detect a truncated-but-non-empty file; nothing short of running it can.
// Sniffing the contents for an npm entrypoint was considered and rejected as brittle
// across npm versions.
function hasAccess(path, mode) {
  let ok = true;
  try {
    accessSync(path, mode);
  } catch {
    ok = false;
  }
  return ok;
}

function isRunnableFile(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    stat = null; // missing or a broken symlink
  }
  // statSync succeeds on a file this process cannot READ, and node needs to read the
  // entrypoint. Checking here rather than at spawn time is what lets an unreadable
  // candidate fall through to the next rung instead of ending the search with EACCES.
  return stat?.isFile() === true && stat.size > 0 && hasAccess(path, constants.R_OK);
}

// The sibling `npx` is the one candidate the OS execs itself rather than handing to
// node, so it has to carry the execute bit as well. Without this check a non-executable
// sibling would be reported as resolved and then die with EACCES, having consumed the
// rung that would otherwise have fallen through.
function isExecutableFile(path) {
  return isRunnableFile(path) && hasAccess(path, constants.X_OK);
}

/**
 * Resolve HOW to invoke npx, as a command plus the argv that must precede the package
 * name. Never returns anything that needs a shell.
 *
 * Bare `npx` (what this used to spawn unconditionally) is unreachable on Windows:
 * `spawn` does no PATHEXT resolution outside a shell, so `npx` — a name with no
 * extension — is ENOENT, and `adlc review` died before it ever reached the reviewer.
 * The obvious repair, spawning the sibling `npx.cmd`, is worse: since the
 * CVE-2024-27980 hardening (Node >=18.20.2/20.12.2/21.7.3) spawning a .cmd without
 * `shell: true` throws ERR_CHILD_PROCESS_UNSUPPORTED_SPAWN, and turning the shell ON
 * would hand cmd.exe every `adlc review` argument to re-parse — user-supplied text with
 * `&`, `|` and `^` in it. So .cmd is deliberately never spawned.
 *
 * What is left is what the shims themselves do on their last line — `node npx-cli.js
 * "$@"` — which needs no shell on any platform and passes argv through untouched.
 *
 * WHERE THIS DELIBERATELY DIVERGES FROM THE SHIMS: both shims go on to run
 * `node npm-prefix.js` and PREFER <npm-configured-prefix>/node_modules/npm/bin/npx-cli.js
 * when it exists, so a POSIX user who ran `npm config set prefix ~/.npm-global` and then
 * `npm i -g npm@latest` gets that newer npm's npx from PATH. This resolves the npx
 * BUNDLED with the running node instead, because replicating the override costs a
 * synchronous node subprocess on every dispatch and adds a failure mode to a path whose
 * whole job is to be reachable. The two agree whenever `prefix` is not overridden, and
 * on win32 npm's default globalPrefix IS dirname(process.execPath), so the divergence is
 * POSIX-only and changes which npm VERSION runs, never whether the package resolves.
 *
 * @param {{ platform?: string, execPath?: string, isFile?: (path: string) => boolean,
 *   isExecutable?: (path: string) => boolean }} [env]
 *   Injection seam for the platform-branch tests: no Windows CI job exercises this file.
 * @returns {{ command: string, prefixArgs: string[], resolved: boolean, probed: string[] }}
 */
export function resolveNpxInvocation(env = {}) {
  const platform = env.platform ?? process.platform;
  const execPath = env.execPath ?? process.execPath;
  const isFile = env.isFile ?? isRunnableFile;
  const isExecutable = env.isExecutable ?? isExecutableFile;
  const binDir = dirname(execPath);
  const probed = [];

  for (const segments of NPX_CLI_LAYOUTS[platform === 'win32' ? 'win32' : 'posix']) {
    const npxCli = join(binDir, ...segments);
    probed.push(npxCli);
    if (isFile(npxCli)) return { command: execPath, prefixArgs: [npxCli], resolved: true, probed };
  }

  // No npx-cli.js anywhere we know to look. On POSIX the sibling `npx` is a shebang
  // script that execve runs directly, so it is still a shell-free improvement on a PATH
  // lookup. It is NOT handed to node: depending on the installer that sibling is either
  // a symlink to npx-cli.js or npm's bash script, and the two are indistinguishable
  // without sniffing the contents. Its shebang can therefore pick a different node than
  // the one running us — inherent to exec'ing a script, and no worse than the bare-name
  // spawn this rung replaces. On win32 the sibling is npx.cmd, which is exactly what we
  // refuse to spawn, so that platform skips this rung.
  if (platform !== 'win32') {
    const sibling = join(binDir, 'npx');
    probed.push(sibling);
    if (isExecutable(sibling)) return { command: sibling, prefixArgs: [], resolved: true, probed };
  }

  // Last resort: the pre-existing behaviour. Still ENOENT on Windows, but only for
  // installs that ship no npx-cli.js at all, and it is no worse than what it replaces.
  return { command: 'npx', prefixArgs: [], resolved: false, probed };
}

// External verbs (registry.mjs `external: true`) are not workspace packages, so there is
// no local bin to resolve. They shell out to npx with full argument passthrough
// instead -- this is how `adlc review` reaches the separate `adversarial-review` CLI
// without vendoring it into this monorepo (issue #65). The npx to run is resolved from
// the running node rather than from PATH (issue #233); see resolveNpxInvocation.
function runExternal(packageName, args, spawnFn, npxEnv) {
  const { command, prefixArgs, resolved, probed } = resolveNpxInvocation(npxEnv);
  // Unresolved means we are about to spawn a bare PATH name, which on Windows cannot
  // succeed at all. Naming what was probed -- and what would fix it -- keeps that
  // failure distinguishable from "the package is missing", the misreport that made
  // issue #233 hard to diagnose, since the bare ENOENT reads identically before and
  // after this fix. Deriving npx from PATH instead is deliberately not attempted: PATH
  // is the trust surface this suite is moving away from.
  const failPrefix = resolved
    ? `failed to run npx ${packageName}`
    : `failed to run npx ${packageName} (no npx-cli.js found near this node, so npx must come from PATH; probed ${probed.join(', ')} — install npm into the directory holding this node to fix it)`;
  return runChild(packageName, spawnFn, command, [...prefixArgs, packageName, ...args], failPrefix);
}

export function dispatch(toolName, args, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawn;
  const tool = getTool(toolName);
  if (toolName === 'ticket' && ['pull', 'push', 'sync', 'doctor'].includes(args[0])) {
    return runBin('@adlc/ticket-sync', resolvePackageBin('@adlc/ticket-sync', 'adlc-ticket-sync'), args, spawnFn);
  }
  if (tool?.external) {
    return runExternal(tool.packageName, args, spawnFn, opts.npxEnv);
  }
  return runBin(tool?.packageName ?? `@adlc/${toolName}`, resolveBin(toolName), args, spawnFn);
}

export function dispatchRunner(args, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawn;
  return runBin('@adlc/runner', resolveRunnerBin(), args, spawnFn);
}
