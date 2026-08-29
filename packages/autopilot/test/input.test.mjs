// AC 73 — input grammar: every value from outside is refused with
// `bad-input:<field>` before any side effect, a branch name is only ever
// constructed, and a constructed path that escapes REPO_ROOT is refused.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateIssueNumber, validateOid, validateTicketId, validateModel, validateRepoSpec, branchFor, stagingBranchFor,
  validateToken, validateComponent, underRoot, InputError,
} from '../lib/input.mjs';

const rejects = (fn, field) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err instanceof InputError, `expected InputError, got ${err && err.message}`);
  assert.equal(err.code, `bad-input:${field}`);
  assert.equal(err.exitCode, 1);
};

export function ac73_issueNumberGrammar() {
  assert.equal(validateIssueNumber('12'), 12);
  assert.equal(validateIssueNumber(7), 7);
  for (const bad of ['0', '12a', '../x', '', '-1', '01', '9'.repeat(11), '1e3', null, undefined, ' 12']) rejects(() => validateIssueNumber(bad), 'issue');
  rejects(() => validateIssueNumber('x', 'pinned'), 'pinned');
}
test('AC73: an issue number matches ^[1-9][0-9]{0,9}$ — 0, 12a, ../x and friends are bad-input:issue', ac73_issueNumberGrammar);

export function ac73_oidGrammar() {
  const oid = 'a'.repeat(40);
  assert.equal(validateOid(oid), oid);
  rejects(() => validateOid('a'.repeat(39)), 'oid');
  rejects(() => validateOid('A'.repeat(40)), 'oid');
  rejects(() => validateOid('a'.repeat(64)), 'oid');
  assert.equal(validateOid('b'.repeat(64), { sha256: true }), 'b'.repeat(64));
  rejects(() => validateOid('b'.repeat(40), { sha256: true, field: 'base' }), 'base');
}
test('AC73: an OID is exactly 40 (or 64 on SHA-256) lower-case hex — 39 chars is bad-input:oid', ac73_oidGrammar);

export function ac73_ticketIdGrammar() {
  assert.equal(validateTicketId('T-01M0Z3FN7SAS4HAH7CS63YQ0DH'), 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH');
  rejects(() => validateTicketId('T-01m0z3fn7sas4hah7cs63yq0dh'), 'ticket'); // lower-case ULID is refused, never folded
  rejects(() => validateTicketId('T55'), 'ticket');
  rejects(() => validateTicketId('T-01M0Z3FN7SAS4HAH7CS63YQ0DI'), 'ticket'); // I is not Crockford
}
test('AC73: a ticket id is T-<26 upper-case Crockford chars>; a lower-case ULID is bad-input:ticket', ac73_ticketIdGrammar);

export function ac73_branchIsConstructedNeverSupplied() {
  assert.equal(branchFor('42'), 'adlc/autopilot/issue-42');
  rejects(() => branchFor('42; rm -rf /'), 'issue');
  rejects(() => branchFor('adlc/autopilot/issue-42'), 'issue');
  const token = 'f'.repeat(64);
  assert.equal(stagingBranchFor(token), `adlc/autopilot/staging-${token}`);
  rejects(() => stagingBranchFor('short'), 'token');
  assert.equal(validateToken(token), token);
  assert.equal(validateModel('claude-opus-5'), 'claude-opus-5');
  rejects(() => validateModel('opus;touch /tmp/x'), 'model');
  assert.equal(validateRepoSpec('voodootikigod/adlc'), 'voodootikigod/adlc');
  rejects(() => validateRepoSpec('github.com/voodootikigod/adlc'), 'repo');
}
test('AC73: a branch name is never taken from input — it is built from a validated number/token', ac73_branchIsConstructedNeverSupplied);

export function ac73_pathComponentsAndRealpath() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ap-input-')));
  try {
    mkdirSync(join(root, 'repo', '.worktrees'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    const repo = join(root, 'repo');
    assert.equal(underRoot(repo, ['.worktrees', 'autopilot-issue-7']), join(repo, '.worktrees', 'autopilot-issue-7'), 'a not-yet-existing leaf under an existing ancestor is accepted');
    rejects(() => underRoot(repo, ['..', 'outside']), 'path');
    rejects(() => underRoot(repo, ['a/b']), 'path');
    rejects(() => underRoot(repo, ['a\0b']), 'path');
    // A symlinked component whose realpath escapes the root is refused (AC 73 symlink fixture).
    symlinkSync(join(root, 'outside'), join(repo, '.worktrees', 'escape'));
    rejects(() => underRoot(repo, ['.worktrees', 'escape', 'autopilot-issue-9']), 'path');
    for (const bad of ['.', '..', '', 'a b\t']) rejects(() => validateComponent(bad), 'path');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('AC73: a constructed ISSUE_WT whose realpath escapes REPO_ROOT (symlink fixture) is refused', ac73_pathComponentsAndRealpath);
