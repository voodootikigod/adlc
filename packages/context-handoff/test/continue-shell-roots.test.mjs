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
    // That predates this change and is the documented trade — a neighbour under
    // `.adlc` is denied rather than the guard approximating shell semantics.
    assert.equal(shell(cwd, 'successor-near', 'rm -rf .adlc/handoffs-archive').deny, true);
  });
});
