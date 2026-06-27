import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getTool } from './registry.mjs';

const require = createRequire(import.meta.url);

function packageJsonPath(packageName) {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }
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

function runBin(label, bin, args) {
  if (!bin) {
    return {
      code: 1,
      error: `tool not installed: ${label} - run "npm i -g @adlc/cli" to install the suite`,
    };
  }

  const result = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' });
  if (result.error) return { code: 1, error: `failed to run ${label}: ${result.error.message}` };
  if (result.signal) return { code: 1, error: `${label} terminated by signal ${result.signal}` };
  return { code: typeof result.status === 'number' ? result.status : 1 };
}

export function dispatch(toolName, args) {
  return runBin(`@adlc/${toolName}`, resolveBin(toolName), args);
}

export function dispatchRunner(args) {
  return runBin('@adlc/runner', resolveRunnerBin(), args);
}
