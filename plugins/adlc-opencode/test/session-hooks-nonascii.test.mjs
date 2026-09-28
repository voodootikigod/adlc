// session-hooks-nonascii.test.mjs — the session.idle risk-tier scan must see a
// changed path containing a non-ASCII byte as the path itself. Under the
// default core.quotePath, plain `git diff --name-only` and `git ls-files`
// C-quote such a path, and the quoted form misses the anchored risk-tier globs.
// Real git, one source per scenario.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { auditAdversarialReview } from '../lib/session-hooks.mjs';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });

function initRepo(t) {
  const dir = tmp(t, 'oc-nonascii-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[]}');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

const paths = (r) => r.matches.map((m) => m.path);

test('a committed non-ASCII risk-tier path is matched by its real name (diff source)', (t) => {
  const dir = initRepo(t);
  git(dir, 'checkout', '-q', '-b', 'feature');
  mkdirSync(join(dir, 'secrets'));
  writeFileSync(join(dir, 'secrets', 'señal.pem'), 'k\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'add');
  assert.equal(git(dir, 'status', '--porcelain').trim(), '');
  const r = auditAdversarialReview(dir, { env: {} });
  assert.equal(r.needed, true);
  assert.ok(paths(r).includes('secrets/señal.pem'), JSON.stringify(paths(r)));
});

test('an untracked non-ASCII risk-tier path is matched by its real name (ls-files source)', (t) => {
  const dir = initRepo(t);
  mkdirSync(join(dir, 'secrets'));
  writeFileSync(join(dir, 'secrets', 'señal.pem'), 'k\n');
  const r = auditAdversarialReview(dir, { env: {} });
  assert.equal(r.needed, true);
  assert.ok(paths(r).includes('secrets/señal.pem'), JSON.stringify(paths(r)));
});
