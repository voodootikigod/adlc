// scaffold.test.mjs — the scaffolder writes valid Cursor config, merges hooks
// without clobbering the user's other hooks, and is idempotent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scaffold,
  mergeHooks,
  ensureCursorHooks,
  ensureGitignore,
  ensureFormatterIgnores,
} from '../lib/scaffold.mjs';
import {
  ensureGitignore as coreEnsureGitignore,
  ensureFormatterIgnores as coreEnsureFormatterIgnores,
} from '@adlc/core';

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

test('ensureCursorHooks BACKS UP an unparseable existing hooks.json instead of dropping it', () => {
  const root = mkRepo();
  mkdirSync(join(root, '.cursor'), { recursive: true });
  const original = '{ not json — a company hook lived here';
  writeFileSync(join(root, '.cursor', 'hooks.json'), original);
  const res = ensureCursorHooks(root);
  // ADLC hook is installed...
  const hooks = readJson(join(root, '.cursor', 'hooks.json'));
  assert.match(hooks.hooks.preToolUse[0].command, /adlc-rails-guard/);
  // ...but the original content is preserved verbatim in a backup, not lost.
  assert.ok(res.backedUp, 'a backup path must be reported');
  assert.equal(readFileSync(res.backedUp, 'utf8'), original, 'backup must hold the original bytes');
});

// Issue #97: ensureGitignore/ensureFormatterIgnores used to be independently
// hand-duplicated here and in plugins/adlc-opencode, and drifted out of sync
// across #92's review rounds. Both are now re-exported from @adlc/core's
// shared implementation (see packages/core/test/scaffold-hygiene.test.mjs for
// the behavioral coverage) — assert reference equality so a future edit that
// reintroduces a local copy in only one plugin fails this test instead of
// silently drifting again.
test('scaffold.mjs delegates ensureGitignore/ensureFormatterIgnores to the shared @adlc/core implementation', () => {
  assert.strictEqual(ensureGitignore, coreEnsureGitignore);
  assert.strictEqual(ensureFormatterIgnores, coreEnsureFormatterIgnores);
});

test('scaffold() wires ensureGitignore in so /adlc-init tracks specs/ by default', () => {
  const root = mkRepo();
  const out = scaffold(root);
  const body = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(body, /^!\.adlc\/specs\/$/m);
  assert.equal(out.gitignore.changed, true);
});

