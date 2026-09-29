// review-nonascii-paths.test.mjs — the Stop-hook risk-tier scan must see a
// changed path containing a non-ASCII byte as the path itself.
//
// Under the default core.quotePath, `git diff --name-only` and `git ls-files`
// C-quote such a path ("secrets/se\303\261al.pem"), and the literal quotes and
// escapes defeat the $-anchored risk-tier globs. Each scenario below isolates
// ONE git source (committed diff, untracked listing) against a real repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';
import { runHook } from './helpers/run-hook.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-hook.mjs');
const NODE_DIR = dirname(process.execPath);
const REPO_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', '.bin');
const WITH_ADLC = `${REPO_BIN}:${NODE_DIR}:${process.env.PATH ?? ''}`;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function initRepo(t) {
  const dir = tmp(t, 'adlc-review-nonascii-');
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[]}');
  writeFileSync(join(dir, 'README.md'), 'baseline\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'baseline'], dir);
  return dir;
}

function runReview(dir) {
  let out = '';
  try {
    out = runHook([HOOK, 'review'], {
      input: JSON.stringify({ cwd: dir }),
      encoding: 'utf8',
      env: { ...GIT_ENV, PATH: WITH_ADLC },
      cwd: dir,
    });
  } catch (e) {
    out = e.stdout ?? '';
  }
  return out;
}

test('a COMMITTED risk-tier path with a non-ASCII name triggers the notice (diff source)', (t) => {
  const dir = initRepo(t);
  git(['checkout', '-b', 'feature/x'], dir);
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  writeFileSync(join(dir, 'secrets', 'señal.pem'), 'k\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'add'], dir);
  assert.equal(git(['status', '--porcelain'], dir).trim(), '', 'clean tree: only the branch diff can report the path');
  assert.match(git(['diff', '--name-only', 'main', '--'], dir), /^"/, 'precondition: git quotes this path in plain --name-only output');
  const out = runReview(dir);
  assert.match(out, /adversarial-review/);
  assert.match(out, /señal\.pem/, 'the notice names the real path, not its C-quoted form');
});

test('an UNTRACKED risk-tier path with a non-ASCII name triggers the notice (ls-files source)', (t) => {
  const dir = initRepo(t);
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  writeFileSync(join(dir, 'secrets', 'señal.pem'), 'k\n');
  const out = runReview(dir);
  assert.match(out, /adversarial-review/);
  assert.match(out, /señal\.pem/);
});
