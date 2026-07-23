import { spawnSync } from 'node:child_process';
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

function runBin(label, bin, args, spawnFn) {
  if (!bin) {
    return {
      code: 1,
      error: `tool not installed: ${label} - run "npm i -g @adlc/cli" to install the suite`,
    };
  }

  const result = spawnFn(process.execPath, [bin, ...args], { stdio: 'inherit' });
  if (result.error) return { code: 1, error: `failed to run ${label}: ${result.error.message}` };
  if (result.signal) return { code: 1, error: `${label} terminated by signal ${result.signal}` };
  return { code: typeof result.status === 'number' ? result.status : 1 };
}

// External verbs (registry.mjs `external: true`) are not workspace packages, so there is
// no local bin to resolve. They shell out to `npx <packageName>` with full argument
// passthrough instead -- this is how `adlc review` reaches the separate
// `adversarial-review` CLI without vendoring it into this monorepo (issue #65).
function runExternal(packageName, args, spawnFn) {
  const result = spawnFn('npx', [packageName, ...args], { stdio: 'inherit' });
  if (result.error) return { code: 1, error: `failed to run npx ${packageName}: ${result.error.message}` };
  if (result.signal) return { code: 1, error: `${packageName} terminated by signal ${result.signal}` };
  return { code: typeof result.status === 'number' ? result.status : 1 };
}

export function dispatch(toolName, args, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawnSync;
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
  const spawnFn = opts.spawnFn ?? spawnSync;
  return runBin('@adlc/runner', resolveRunnerBin(), args, spawnFn);
}
