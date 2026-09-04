// A minimal `ctx` for the S5 suites (diffcheck / deps / mirror / gates): real
// git through the real spawn wrapper (recorded), fake handlers for the pinned
// tools a test names (adlc, npm, bwrap …), and the three git spawners of the
// contract built the way lib/git-runner.mjs builds them (base env, no overlay).

import { spawn as cpSpawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { globMatch } from '@adlc/core';
import { createSpawner, DEADLINES } from '../../lib/spawn.mjs';
import { autopilotPaths } from '../../lib/paths.mjs';
import { gitBaseEnv } from '../../lib/git-env.mjs';
import { createRedactor } from '../../lib/redact.mjs';
import { fakeSpawnImpl } from './fake-children.mjs';

export const REAL_GIT = '/usr/bin/git';
export const REAL_NODE = realpathSync(process.execPath);
export const REAL_NPM = join(dirname(REAL_NODE), 'npm');
export const REAL_BWRAP = '/usr/bin/bwrap';
export const TEST_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455667788990aabbccddeeff';

/** Fake handlers by executable path; everything else spawns for real. */
export function mixedSpawnImpl(handlers) {
  const fake = fakeSpawnImpl(handlers);
  const spawnImpl = (exe, args, opts) => (handlers[exe] ? fake.spawnImpl(exe, args, opts) : cpSpawn(exe, args, opts));
  const kill = (pid, signal) => { try { fake.kill(pid, signal); } catch { process.kill(pid, signal); } };
  return { spawnImpl, kill };
}

/** The static protected-path extras of lib/denylist.mjs plus the two trust-root lists' members a test needs. */
export const DENYLIST_GLOBS = Object.freeze([
  '.adlc/**', '.github/**', 'scripts/rails-guard-ci.mjs', 'scripts/mutation-gate.mjs', 'scripts/run-tests.mjs', 'scripts/preflight.mjs',
  'scripts/toolkit-floor.json', 'docs/ci/**', 'CODEOWNERS', 'package.json', '.npmrc', 'packages/rails-guard/**', 'packages/core/**',
]);

export function makeCtx({ repoRoot, handlers = {}, pinned = {}, key = TEST_KEY, baseOid = null, home = null, denylistGlobs = DENYLIST_GLOBS } = {}) {
  const recorder = [];
  const { spawnImpl, kill } = mixedSpawnImpl(handlers);
  const spawn = createSpawner({ recorder, spawnImpl, kill });
  const pinnedAll = {
    git: REAL_GIT, 'git:realpath': realpathSync(REAL_GIT), node: process.execPath, 'node:realpath': REAL_NODE, npm: REAL_NPM,
    adlc: '/fake/adlc', bwrap: REAL_BWRAP, gh: '/fake/gh', claude: '/fake/claude', ...pinned,
  };
  const env = { path: process.env.PATH, home: home ?? repoRoot, base: { PATH: process.env.PATH, HOME: home ?? repoRoot, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' } };
  const gitEnv = gitBaseEnv({ path: env.path, home: env.home });
  const local = (cwd, args, { deadlineMs = DEADLINES.git, stdinBytes } = {}) =>
    spawn({ argv: [pinnedAll.git, ...args], cwd, env: gitEnv, stdinBytes, deadlineMs, label: `git:${args.find((a) => !a.startsWith('-'))}` });
  const localOut = async (cwd, args) => {
    const r = await local(cwd, args);
    if (r.status !== 0) throw Object.assign(new Error(`git ${args.join(' ')} failed: ${r.stderr}`), { code: 'git-failed' });
    return r.stdout.trim();
  };
  const observe = async (k) => { const r = await local(repoRoot, ['config', '--file', join(repoRoot, '.git', 'config'), '--get', k]); return r.status === 0 ? r.stdout.trim() : null; };
  const denylist = { globs: denylistGlobs, matches: (p) => denylistGlobs.some((g) => globMatch(g, p)) };
  return {
    repoRoot, paths: autopilotPaths(repoRoot), spawn, recorder, pinned: pinnedAll, env, key, secretValues: [key],
    redactor: createRedactor({ secretValues: [key] }), git: { local, localOut, observe }, baseOid, denylist,
    log: () => {}, now: Date.now, dryRun: false,
  };
}

/** Argv-shape helpers over the recorder. */
export const spawnsOf = (ctx, exe) => ctx.recorder.filter((r) => r.argv[0] === exe);
export const gitSpawns = (ctx) => spawnsOf(ctx, ctx.pinned.git).map((r) => r.argv.slice(1));
