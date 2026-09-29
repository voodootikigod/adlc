// entry-guard.mjs — run a repo script the two ways its CLI entry guard must
// tell apart: as the program itself, and as a module imported by another.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SPAWN_TIMEOUT_MS = 30_000;

/** Run `scriptPath` as the program, with no extra argv unless `args` are given. */
export function runAsProgram(scriptPath, { args = [], cwd, input = '' } = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd, input, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, BASE_REF: 'origin/main' },
  });
}

/**
 * Import `scriptPath` from an inline module, where process.argv[1] is
 * undefined. The guard must neither throw nor run the CLI.
 */
export function importFromInlineModule(scriptPath, { cwd } = {}) {
  const source = `await import(${JSON.stringify(pathToFileURL(scriptPath).href)});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd, input: '', encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS,
  });
}
