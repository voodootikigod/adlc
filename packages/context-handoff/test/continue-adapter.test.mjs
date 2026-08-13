// continue-adapter.test.mjs — frozen contracts 21 and 23 at the level this
// package owns: agent writes to `.adlc/handoffs/content/**` are protected
// paths, and `adlc handoff continue` is a mutating subcommand.
//
// The enforcing tiers decide with these two predicates, so a hole here is a
// hole in every adapter at once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HANDOFF_MUTATING_SUBCOMMANDS,
  classifyProtectedTarget,
  evaluateHandoffPreToolUse,
  isHandoffMutatingShell,
  isProtectedHandoffPath,
} from '../lib/adapter.mjs';

test('capture bodies are protected paths, however the path is spelled', () => {
  for (const p of [
    '.adlc/handoffs/content',
    '.adlc/handoffs/content/sess-a.md',
    './.adlc/handoffs/content/sess-a.md',
    '.adlc/handoffs/x/../content/sess-a.md',
    '.adlc\\handoffs\\content\\sess-a.md',
    '.adlc/handoffs/content/nested/deeper.md',
  ]) {
    assert.equal(isProtectedHandoffPath(p), true, `${p} must be protected`);
  }
});

test('the content guard does not swallow neighbouring paths', () => {
  for (const p of [
    '.adlc/handoffs/content-other/x.md',
    '.adlc/handoffs-other/content/x.md',
    'content/x.md',
    'docs/content/x.md',
  ]) {
    assert.equal(isProtectedHandoffPath(p), false, `${p} must not be protected`);
  }
});

test('a symlink pointing into the capture store is protected too', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-content-link-'));
  try {
    mkdirSync(join(root, '.adlc', 'handoffs', 'content'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'handoffs', 'content', 'sess-a.md'), 'body\n', 'utf8');
    symlinkSync(join(root, '.adlc', 'handoffs', 'content'), join(root, 'alias'));

    // Lexically innocent, and the filesystem follows it straight into the store.
    assert.equal(isProtectedHandoffPath('alias/sess-a.md'), false);
    assert.deepEqual(classifyProtectedTarget(root, 'alias/sess-a.md'), {
      protected: true,
      via: 'symlink',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an agent write to a capture body is denied by the gate itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-content-gate-'));
  try {
    const verdict = evaluateHandoffPreToolUse({
      root,
      sessionId: 'sess-a',
      observed: {},
      editRelPaths: ['.adlc/handoffs/content/sess-a.md'],
    });
    assert.equal(verdict.deny, true);
    assert.ok(
      verdict.reasons.some((r) => r.startsWith('path_protected:')),
      `expected a path_protected reason, got ${JSON.stringify(verdict.reasons)}`,
    );

    // …while an ordinary file in the same clean repo stays editable.
    assert.equal(
      evaluateHandoffPreToolUse({ root, sessionId: 'sess-a', editRelPaths: ['src/app.mjs'] }).deny,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('continue is a mutating handoff subcommand', () => {
  assert.equal(HANDOFF_MUTATING_SUBCOMMANDS.has('continue'), true);
  for (const command of [
    'adlc handoff continue --deny-session s --write',
    'npx adlc handoff continue --deny-session s',
    'node ./packages/context-handoff/bin/handoff.mjs continue --write',
    'HANDOFF=1 handoff.mjs continue',
    '$(which adlc) handoff continue --write',
    'adlc handoff CONTINUE --write',
  ]) {
    assert.equal(isHandoffMutatingShell(command), true, `${command} must be flagged`);
  }
});

test('the shell classifier still leaves read-only handoff calls alone', () => {
  for (const command of ['adlc handoff --help', 'git log --oneline', 'echo continue']) {
    assert.equal(isHandoffMutatingShell(command), false, `${command} must not be flagged`);
  }
});
