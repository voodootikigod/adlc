// The /tmp fixture-boundary guard is locked permanently, not by a ticket rail:
// scripts/rails-guard-ci.mjs declares it in REPO_TRUST_ROOTS, so the rails-guard
// CI job refuses any pull request that edits it without the trust-root
// ceremony. Driven against the real wrapper in a throwaway repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'rails-guard-ci.mjs');
const GUARD = 'scripts/test/tmp-fixture-boundary.test.mjs';
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: GIT_ENV });
}

function write(dir, path, body) {
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), body);
}

// Base carries one active rail elsewhere, so the gate is live; the PR edits `edited`.
function gateExit(t, edited) {
  const dir = tmp(t, 'rgci-guard-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'a@b.c']);
  git(dir, ['config', 'user.name', 'x']);
  write(dir, '.adlc/tickets.json', JSON.stringify({ tickets: [{ id: 'T1', title: 'fixture', rails: ['src/critical/**'] }] }));
  write(dir, 'src/critical/auth.mjs', 'orig\n');
  write(dir, 'src/other.mjs', 'orig\n');
  write(dir, GUARD, 'orig\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  git(dir, ['checkout', '-q', '-b', 'feat']);
  write(dir, edited, 'changed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'change']);
  const r = spawnSync(process.execPath, [SCRIPT, 'main'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, RAILS_BASE: '', BASE_REF: '' },
  });
  return r.status;
}

test('a PR editing the /tmp fixture guard is refused by rails-guard (exit 2)', (t) => {
  assert.equal(gateExit(t, GUARD), 2);
});

test('an unrelated edit in the same repository still passes (exit 0)', (t) => {
  assert.equal(gateExit(t, 'src/other.mjs'), 0);
});

test('CODEOWNERS names an owner for the /tmp fixture guard', () => {
  const owners = readFileSync(join(REPO, 'CODEOWNERS'), 'utf8');
  assert.match(owners, new RegExp(`^/${GUARD.replaceAll('.', '\\.')}\\s+@\\S+`, 'm'));
});
