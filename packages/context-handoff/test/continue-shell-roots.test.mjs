// continue-shell-roots.test.mjs — the shell target guard covers the whole
// handoffs tree, not just the deny markers.
//
// The session this matters for is the one with no deny at all: a successor
// whose deny is CONSUMED holds no D1-D3, so its shell runs freely. Without
// ancestor coverage of `.adlc/handoffs`, `rm -rf` on that directory takes the
// captures, finals, resume-auths and locks — the evidence its own
// authorization rests on — and the paths are gitignored, so no diff shows it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { classifyProtectedTarget, evaluateHandoffPreToolUse } from '../lib/adapter.mjs';
import {
  KEYED,
  contentPathFor,
  denyPathFor,
  readJson,
  run,
  seedBoundDeny,
  withTempRepo,
} from './continue-cli-support.mjs';

/** A continuation, leaving the successor free of any deny. */
function continued(cwd, denier, successor) {
  seedBoundDeny(cwd, denier, 'T155');
  const r = run(
    ['continue', '--deny-session', denier, '--session', successor, '--write', '--json'],
    { cwd, env: KEYED },
  );
  assert.equal(r.code, 0);
  assert.equal(readJson(denyPathFor(cwd, denier)).status, 'consumed');
  return JSON.parse(r.stdout);
}

const shell = (cwd, sessionId, command) =>
  evaluateHandoffPreToolUse({ root: cwd, sessionId, observed: {}, isBash: true, bashCommand: command });

test('a consumed successor cannot delete the handoffs tree', () => {
  withTempRepo((cwd) => {
    continued(cwd, 'denier-rm', 'successor-rm');
    // Prove the premise: this session is NOT otherwise denied.
    assert.equal(
      evaluateHandoffPreToolUse({ root: cwd, sessionId: 'successor-rm', editRelPaths: ['src/app.mjs'] }).deny,
      false,
      'the successor is free to work — that is what makes the shell reachable',
    );

    for (const command of [
      'rm -rf .adlc/handoffs',
      'rm -rf ./.adlc/handoffs',
      'rm -rf .adlc/handoffs/',
      'rm -rf .adlc',
      'mv .adlc/handoffs /tmp/stash',
    ]) {
      const verdict = shell(cwd, 'successor-rm', command);
      assert.equal(verdict.deny, true, `${command} must be denied`);
      assert.ok(
        verdict.reasons.some((r) => r.startsWith('path_protected_shell:')),
        `${command}: expected a path_protected_shell reason, got ${JSON.stringify(verdict.reasons)}`,
      );
    }

    // The artifacts are still there — the guard denied, it did not clean up.
    assert.equal(existsSync(contentPathFor(cwd, 'denier-rm')), true);
  });
});

test('the individual artifacts under handoffs are covered as targets', () => {
  withTempRepo((cwd) => {
    for (const rel of [
      '.adlc/handoffs',
      '.adlc/handoffs/finals',
      '.adlc/handoffs/content',
      '.adlc/handoffs/denies',
    ]) {
      assert.equal(
        classifyProtectedTarget(cwd, rel).protected,
        true,
        `${rel} must be a protected target`,
      );
    }
  });
});

test('ordinary shell in the same session is still allowed', () => {
  withTempRepo((cwd) => {
    continued(cwd, 'denier-ok', 'successor-ok');
    for (const command of ['ls src', 'node --test packages/context-handoff/test', 'git status', 'rm -rf dist']) {
      const verdict = shell(cwd, 'successor-ok', command);
      assert.equal(verdict.deny, false, `${command} must be allowed: ${JSON.stringify(verdict.reasons)}`);
    }
  });
});

test('a same-named directory outside the ledger is not covered', () => {
  withTempRepo((cwd) => {
    continued(cwd, 'denier-near', 'successor-near');
    for (const command of ['rm -rf handoffs', 'rm -rf docs/handoffs', 'rm -rf build/.adlc-cache']) {
      assert.equal(shell(cwd, 'successor-near', command).deny, false, `${command} must be allowed`);
    }
    // Inside `.adlc` is a different matter, and deliberately so: every token's
    // ancestors are candidates, so `.adlc` itself reaches the protected tree.
    // That predates this change and is the documented trade — a MUTATING
    // neighbour under `.adlc` is denied rather than the guard approximating
    // shell semantics.
    assert.equal(shell(cwd, 'successor-near', 'rm -rf .adlc/handoffs-archive').deny, true);
  });
});

test('a positively read-only neighbour under .adlc is not covered', () => {
  withTempRepo((cwd) => {
    continued(cwd, 'denier-read', 'successor-read');
    // Same `.adlc`-ancestor shape as the denied case above, but nothing here can
    // delete anything — the guard's own rationale (deletion reaching the deny
    // store) does not apply, and the `Read` tool already bypasses this check
    // entirely for the identical bytes, so blocking these was pure friction.
    for (const command of [
      'ls .adlc/manifest.d',
      'cat .adlc/handoffs-archive/note.txt',
      'grep -i autopilot .adlc/manifest.d/x.jsonl',
      'git status .adlc',
    ]) {
      const verdict = shell(cwd, 'successor-read', command);
      assert.equal(verdict.deny, false, `${command} must be allowed: ${JSON.stringify(verdict.reasons)}`);
    }
    // A command mixing a read-only prefix with a later mutator is NOT positively
    // read-only (shellIsPositivelyReadOnly requires every segment to match), so
    // it must still fall through to the existing protected-target check.
    assert.equal(
      shell(cwd, 'successor-read', 'ls .adlc && rm -rf .adlc/handoffs').deny,
      true,
    );
  });
});

test('a redirect or output-flag smuggled onto a read-only prefix is still denied (regression)', () => {
  withTempRepo((cwd) => {
    continued(cwd, 'denier-redirect', 'successor-redirect');
    // shellIsPositivelyReadOnly alone only checks the LEADING command name per
    // segment — `cat x > y` and `git diff --output=y` both start with an
    // allowlisted verb, so that classifier alone reads them as read-only even
    // though both overwrite `y`. The guard must use the full ladder
    // (`readOnly && !writeOption`, which also ANDs in the redirect-aware
    // `!shellHasMutation`) so these still hit the protected-target check.
    for (const command of [
      // Redirect target reaches `.adlc` only as an ancestor (the same "covers"
      // shape as the allowed read-only case above) — proves this isn't caught
      // merely because the argument being read is itself under `.adlc/`.
      'cat /dev/null > .adlc/manifest.d/pwned.jsonl',
      'cat /dev/null >> .adlc/manifest.d/pwned.jsonl',
      'git diff --output=.adlc/manifest.d/pwned.jsonl',
      // Quoted output flag: the char before `--` is a quote, not whitespace —
      // an earlier fix here missed this (adversarial-review round 3).
      'git diff "--output=.adlc/manifest.d/pwned.jsonl"',
      // Unspaced sed `w` — GNU sed accepts this with zero space, verified
      // against the real binary; an earlier fix here required `\s+`.
      "sed -n 'w.adlc/manifest.d/pwned.jsonl' /dev/null",
    ]) {
      const verdict = shell(cwd, 'successor-redirect', command);
      assert.equal(verdict.deny, true, `${command} must still be denied: ${JSON.stringify(verdict.reasons)}`);
    }
  });
});
