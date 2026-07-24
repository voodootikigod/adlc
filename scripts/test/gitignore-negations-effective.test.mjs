// Concern: every negation this repository declares in .gitignore must actually
// take effect.
//
// gitignore is LAST-MATCH-WINS, so a negation placed above a blanket rule that
// re-matches it is dead — the file still READS as though the path were tracked,
// but git ignores it and `git add -A` silently omits it. That has bitten this
// repo repeatedly: `adlc ticket store migrate` used to relocate the `.adlc/*`
// blanket to the end of the file, stranding every negation above it, and the
// symptom only surfaced later as a CI gate rejecting a PR for missing files.
//
// This asserts BEHAVIOUR via `git check-ignore` rather than inspecting the text,
// because only git can settle precedence. It is deliberately generic: it covers
// negations that do not exist yet, so a future stranding fails here rather than
// in CI on an unrelated PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// A concrete path the negation is meant to un-ignore. --no-index means it need
// not exist on disk.
//
// A trailing-slash negation probes the DIRECTORY ITSELF, not a member: `!dir/`
// exists so git will descend into the directory, and it is idiomatic to pair it
// with a `dir/*` rule that re-ignores the contents so only specific members are
// then negated (this repo does exactly that for `.omo/evidence/`). Probing a
// member would flag that correct, intentional pattern as dead.
function samplePath(pattern) {
  const body = pattern.slice(1);
  if (body.endsWith('/**')) return `${body.slice(0, -3)}/sample-probe.json`;
  if (body.endsWith('/')) return body.slice(0, -1);
  if (body.endsWith('*')) return `${body.slice(0, -1)}sample-probe`;
  return body;
}

function isIgnoredIn(cwd, path) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd, stdio: 'ignore' });
    return true;
  } catch (err) {
    // Exit 1 means "not ignored"; anything else is an operational failure and
    // must not be mistaken for a pass.
    if (err.status === 1) return false;
    throw new Error(`git check-ignore failed for ${path}: ${err.message}`);
  }
}

const isIgnored = (path) => isIgnoredIn(REPO_ROOT, path);

const negations = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.startsWith('!') && line.length > 1);

test('every .gitignore negation is effective, not shadowed by a later blanket rule', () => {
  assert.ok(negations.length > 0, 'expected .gitignore to declare negations — otherwise this guard is vacuous');
  const dead = negations.filter((pattern) => isIgnored(samplePath(pattern)));
  assert.deepEqual(
    dead,
    [],
    'these negations are dead — a later pattern re-ignores the paths they name, so git will silently omit them from commits. '
    + 'Move them BELOW the blanket rule that shadows them.',
  );
});

test('.adlc/findings.jsonl is tracked (its negation is live), so the P7 ledger is portable', () => {
  // ADR 0014: the curated findings ledger is tracked like the manifest so the
  // P5 to P7 bridge survives fleet worktrees and CI, and the lesson-foundry gate
  // can run against real data. A reorder that strands this negation silently
  // stops git tracking the ledger — pin it BY NAME here, not only via the generic
  // scan above, so the decision has a dedicated guard.
  assert.equal(
    isIgnored('.adlc/findings.jsonl'),
    false,
    '.adlc/findings.jsonl must be un-ignored (tracked); its `!` negation is missing or stranded above the .adlc/* blanket',
  );
});

test('the guard itself detects a stranded negation (self-test)', () => {
  // Pins the mechanism the assertion above depends on. Without this, a bug that
  // made isIgnored() always return false would leave the real test green while
  // detecting nothing. A negation ABOVE a blanket rule that re-matches it must
  // be reported dead; the same negation BELOW it must be reported live.
  const dir = mkdtempSync(join(tmpdir(), 'adlc-ignore-selftest-'));
  try {
    // check-ignore requires a repository; outside one it exits 128, which
    // isIgnoredIn correctly refuses to read as "not ignored".
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, '.gitignore'), ['!.adlc/keep.json', '.adlc/*', ''].join('\n'));
    assert.equal(isIgnoredIn(dir, '.adlc/keep.json'), true, 'a negation above the blanket rule is dead');

    writeFileSync(join(dir, '.gitignore'), ['.adlc/*', '!.adlc/keep.json', ''].join('\n'));
    assert.equal(isIgnoredIn(dir, '.adlc/keep.json'), false, 'the same negation below the blanket rule is live');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
