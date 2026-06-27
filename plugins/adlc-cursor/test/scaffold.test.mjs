// scaffold.test.mjs — the scaffolder writes valid Cursor config, merges hooks
// without clobbering the user's other hooks, and is idempotent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scaffold, mergeHooks, ensureCursorHooks } from '../lib/scaffold.mjs';

const mkRepo = () => mkdtempSync(join(tmpdir(), 'adlc-cursor-scaffold-'));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('scaffold creates config, hooks.json (rails-guard + audit) and the rule', () => {
  const root = mkRepo();
  const res = scaffold(root);
  assert.ok(existsSync(join(root, '.adlc', 'config.json')));
  assert.ok(existsSync(join(root, '.cursor', 'rules', 'adlc.mdc')));

  const hooks = readJson(join(root, '.cursor', 'hooks.json'));
  assert.equal(hooks.version, 1);
  assert.match(hooks.hooks.preToolUse[0].command, /adlc-rails-guard\.mjs/);
  assert.equal(hooks.hooks.preToolUse[0].failClosed, false);
  assert.match(hooks.hooks.afterFileEdit[0].command, /adlc-audit\.mjs/);
  assert.ok(res.config.created && res.rule.created);
});

test('mergeHooks preserves a user existing hook and does not duplicate ADLC entries', () => {
  const userHooks = {
    version: 1,
    hooks: {
      preToolUse: [{ command: './scripts/my-guard.sh', matcher: 'curl' }],
      beforeShellExecution: [{ command: './scripts/net.sh' }],
    },
  };
  const once = mergeHooks(userHooks);
  // user's entries survive
  assert.ok(once.hooks.preToolUse.some((e) => e.command === './scripts/my-guard.sh'));
  assert.ok(once.hooks.beforeShellExecution.some((e) => e.command === './scripts/net.sh'));
  // ours added
  assert.ok(once.hooks.preToolUse.some((e) => /adlc-rails-guard/.test(e.command)));
  // idempotent: merging again does not add a second ADLC entry
  const twice = mergeHooks(once);
  const adlcCount = twice.hooks.preToolUse.filter((e) => /adlc-rails-guard/.test(e.command)).length;
  assert.equal(adlcCount, 1);
});

test('ensureCursorHooks recovers from an unparseable existing hooks.json', () => {
  const root = mkRepo();
  mkdirSync(join(root, '.cursor'), { recursive: true });
  writeFileSync(join(root, '.cursor', 'hooks.json'), '{ not json');
  ensureCursorHooks(root);
  const hooks = readJson(join(root, '.cursor', 'hooks.json'));
  assert.match(hooks.hooks.preToolUse[0].command, /adlc-rails-guard/);
});
