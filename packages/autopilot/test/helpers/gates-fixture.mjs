// Real temporary git repositories for the S5 suites, and the fixture that the
// real-bwrap gate test clones: a copy of this repository's own gate scripts and
// the packages they import, so `scripts/rails-guard-ci.mjs` and
// `scripts/mutation-gate.mjs` run for real inside a sandboxed GATE_REPO.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));

const GIT_ENV = {
  PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-08-28T00:00:00Z', GIT_COMMITTER_DATE: '2026-08-28T00:00:00Z',
};

/** Synchronous git for fixture building (never the code under test). */
export function git(cwd, args, { input } = {}) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: GIT_ENV, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export const scratch = (prefix) => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));

/** Write files ({ path: text }); a null value deletes. */
export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    if (content === null) { rmSync(p, { force: true }); continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

export function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

/** `git init -b main` + one base commit; returns { root, baseOid }. */
export function makeRepo({ files = { 'README.md': 'base\n' }, dir = null } = {}) {
  const root = dir ?? scratch('ap-s5-');
  git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'gc.auto', '0']); git(root, ['config', 'gc.autoDetach', 'false']);
  writeFiles(root, files);
  const baseOid = commitAll(root, 'base');
  return { root, baseOid };
}

/** Create and check out the issue branch from `fromOid`. */
export function checkoutIssueBranch(root, issue, fromOid) {
  git(root, ['checkout', '-q', '-b', `adlc/autopilot/issue-${issue}`, fromOid]);
}

/** A linked worktree at ISSUE_WT on the issue branch (the run's own worktree). */
export function addIssueWorktree(root, issueWt, issue, fromOid) {
  git(root, ['worktree', 'add', '-q', '-b', `adlc/autopilot/issue-${issue}`, issueWt, fromOid]);
  return issueWt;
}

// ---- the real-gate fixture -----------------------------------------------------------

export const FIXTURE_PACKAGES = ['core', 'tickets', 'gate-manifest', 'rails-guard', 'hollow-test'];
export const VALID_CONFIG = {
  acknowledgedNewRailBypass: true, trustedCodeownersAttested: true, securityMode: 'unsigned-fallback',
  signers: { alice: { role: 'builder' } }, revokedKeys: [], securitySensitivePatterns: [], maxBundleAgeDays: 14,
};
const STUB_GATE = '#!/usr/bin/env node\nprocess.exit(0);\n';

/** Copy the real gate scripts + their packages into `root` (no tests, no node_modules). */
export function seedRealGateFixture(root) {
  const filter = (src) => !/\/(node_modules|test|cli-test|adapter-test|\.git)(\/|$)/.test(src);
  for (const p of FIXTURE_PACKAGES) cpSync(join(REPO, 'packages', p), join(root, 'packages', p), { recursive: true, filter });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const s of ['rails-guard-ci.mjs', 'mutation-gate.mjs', 'preflight.mjs', 'toolkit-floor-check.mjs']) cpSync(join(REPO, 'scripts', s), join(root, 'scripts', s));
  for (const s of ['run-tests.mjs', 'scan-findings-ledger.mjs', 'guard-findings-ledger-append-only.mjs', 'check-reviewer-directed-comments.mjs']) writeFileSync(join(root, 'scripts', s), STUB_GATE);
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'fixture', version: '1.11.0', private: true, workspaces: ['packages/*'] }, null, 2) + '\n',
    '.gitignore': 'node_modules/\n',
    '.adlc/config.json': JSON.stringify(VALID_CONFIG, null, 2) + '\n',
    'packages/foo/package.json': JSON.stringify({ name: '@adlc/foo', version: '1.11.0', type: 'module', scripts: { test: 'node --test test/*.test.mjs' } }, null, 2) + '\n',
    'packages/foo/lib/x.mjs': 'export function add(a, b) { return a + b; }\n',
    'packages/foo/test/x.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../lib/x.mjs';\ntest('add', () => { assert.equal(add(1, 2), 3); });\n",
  });
}

/** A hand-built dependency tree: `node_modules/@adlc/<x>` → `../../packages/<x>` relative links (what npm would create). */
export function seedDepsTree(dir, names = [...FIXTURE_PACKAGES, 'foo']) {
  mkdirSync(join(dir, 'node_modules', '@adlc'), { recursive: true });
  for (const x of names) symlinkSync(`../../packages/${x}`, join(dir, 'node_modules', '@adlc', x));
  return join(dir, 'node_modules');
}

export const executable = (p, text) => { writeFileSync(p, text); chmodSync(p, 0o755); return p; };
export const exists = existsSync;
