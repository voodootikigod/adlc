// prompt-senders.test.mjs — the detector behind the prompt-fencing
// completeness sweep. The sweep can only demand a classification for modules
// this detector reports, so every way a module reaches a model has to count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendsPrompts, promptSendingModules } from '../prompt-senders.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('a static named import of a prompt sender from core counts', () => {
  assert.equal(sendsPrompts("import { fence, complete } from '@adlc/core';"), true);
  assert.equal(sendsPrompts("import { fan as fanOut } from '../../core/index.mjs';"), true);
});

test('a static import of only non-sending helpers does not count', () => {
  assert.equal(sendsPrompts("import { fence, isDirty } from '@adlc/core';"), false);
});

test('a dynamic import resolved with .then(({ complete }) => ...) counts', () => {
  const src = "const run = (c) => import('@adlc/core').then(({ complete }) => complete(c));";
  assert.equal(sendsPrompts(src), true);
});

test('a dynamic import destructured by await counts', () => {
  assert.equal(sendsPrompts("const { fanProviders } = await import('@adlc/core');"), true);
});

test('a dynamic import destructuring only non-sending helpers does not count', () => {
  assert.equal(sendsPrompts("const { isGitRepo, isDirty } = await import('@adlc/core');"), false);
});

test('a dynamic import whose bindings cannot be read counts (fail closed)', () => {
  assert.equal(sendsPrompts("const core = await import('@adlc/core'); core.complete(x);"), true);
  assert.equal(sendsPrompts("import('@adlc/core').then((m) => m.complete(x));"), true);
});

test('a host-session prompt send counts', () => {
  assert.equal(sendsPrompts('await session.prompt({ path: { id }, body });'), true);
  assert.equal(sendsPrompts("spawn(bin, ['-p', prompt, '--no-session']);"), true);
  assert.equal(sendsPrompts("const argv = ['--print', prompt];"), true);
});

test('unrelated source does not count', () => {
  assert.equal(sendsPrompts("import { readFileSync } from 'node:fs';\nconst p = '-p';"), false);
});

test('the repo walk finds the dynamic-import sender in gate-fuzzing', () => {
  assert.ok(promptSendingModules(REPO_ROOT).includes('packages/gate-fuzzing/lib/fan.mjs'));
});

test('the repo walk descends into nested lib directories', () => {
  assert.ok(promptSendingModules(REPO_ROOT).includes('packages/fleet/lib/adapters/claude-code.mjs'));
});

test('the repo walk covers host plugins', () => {
  const found = promptSendingModules(REPO_ROOT);
  assert.ok(found.includes('plugins/adlc-pi/lib/prosecutor.mjs'));
  assert.ok(found.includes('plugins/adlc-opencode/lib/prosecute-runner.mjs'));
});

test('the repo walk skips test suites', () => {
  assert.equal(promptSendingModules(REPO_ROOT).filter((f) => /\/(test|fixtures)\//.test(f)).length, 0);
});
