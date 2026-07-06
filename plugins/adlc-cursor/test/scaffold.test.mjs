// scaffold.test.mjs — the scaffolder writes valid Cursor config, merges hooks
// without clobbering the user's other hooks, and is idempotent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scaffold,
  mergeHooks,
  ensureCursorHooks,
  ensureGitignore,
  ensureFormatterIgnores,
  PLUGIN_ROOT,
} from '../lib/scaffold.mjs';
import {
  ensureGitignore as coreEnsureGitignore,
  ensureFormatterIgnores as coreEnsureFormatterIgnores,
} from '@adlc/core';

const mkRepo = () => mkdtempSync(join(tmpdir(), 'adlc-cursor-scaffold-'));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('scaffold creates config, hooks.json (dispatcher + audit + shell advisory) and the rule', () => {
  const root = mkRepo();
  const res = scaffold(root);
  assert.ok(existsSync(join(root, '.adlc', 'config.json')));
  assert.ok(existsSync(join(root, '.cursor', 'rules', 'adlc.mdc')));

  const hooks = readJson(join(root, '.cursor', 'hooks.json'));
  assert.equal(hooks.version, 1);
  assert.match(hooks.hooks.preToolUse[0].command, /adlc-pretool\.mjs/);
  assert.equal(hooks.hooks.preToolUse[0].failClosed, false);
  assert.match(hooks.hooks.afterFileEdit[0].command, /adlc-audit\.mjs/);
  assert.match(hooks.hooks.beforeShellExecution[0].command, /adlc-shell-advisory\.mjs/);
  assert.equal(hooks.hooks.beforeShellExecution[0].failClosed, false);
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
  assert.ok(once.hooks.preToolUse.some((e) => /adlc-pretool/.test(e.command)));
  assert.ok(once.hooks.beforeShellExecution.some((e) => /adlc-shell-advisory/.test(e.command)));
  // idempotent: merging again does not add second ADLC entries
  const twice = mergeHooks(once);
  const adlcCount = twice.hooks.preToolUse.filter((e) => /adlc-pretool/.test(e.command)).length;
  assert.equal(adlcCount, 1);
  const shellCount = twice.hooks.beforeShellExecution.filter((e) => /adlc-shell-advisory/.test(e.command)).length;
  assert.equal(shellCount, 1);
});

// T18 amendment 1: preToolUse is rewired to the SINGLE dispatcher; a
// pre-existing direct adlc-rails-guard.mjs entry is MIGRATED (replaced), so
// two ADLC preToolUse entries can never coexist (Cursor's multi-entry
// permission-combination semantics are unpinned).
test('mergeHooks MIGRATES a pre-T18 direct adlc-rails-guard.mjs preToolUse entry to the dispatcher (T18)', () => {
  const preT18 = {
    version: 1,
    hooks: {
      preToolUse: [
        { command: './scripts/my-guard.sh', matcher: 'curl' },
        { command: 'node "/some/install/hooks/adlc-rails-guard.mjs"', matcher: '.*', timeout: 10, failClosed: false },
      ],
      afterFileEdit: [{ command: 'node "/some/install/hooks/adlc-audit.mjs"', timeout: 10, failClosed: false }],
    },
  };
  const merged = mergeHooks(preT18);
  const adlcEntries = merged.hooks.preToolUse.filter((e) => /adlc-/.test(e.command));
  assert.equal(adlcEntries.length, 1, 'exactly ONE ADLC preToolUse entry (the dispatcher)');
  assert.match(adlcEntries[0].command, /adlc-pretool\.mjs/);
  assert.ok(!merged.hooks.preToolUse.some((e) => /adlc-rails-guard\.mjs/.test(e.command)),
    'the old direct rails-guard entry must be gone');
  // the user's own guard survives the migration
  assert.ok(merged.hooks.preToolUse.some((e) => e.command === './scripts/my-guard.sh'));
});

// T18 AC4: the UNPINNED events (stop / beforeSubmitPrompt) are DISABLED by
// default — mergeHooks does not wire them — and only an explicit opt-in wires
// them. Turning the flag back off removes them again (restores the default).
test('mergeHooks ships stop/preflight DISABLED by default; wireUnpinned opts in; unflagging removes them (T18 AC4)', () => {
  const base = mergeHooks(undefined);
  assert.equal(base.hooks.stop, undefined, 'stop must not be wired by default (event unpinned)');
  assert.equal(base.hooks.beforeSubmitPrompt, undefined, 'beforeSubmitPrompt must not be wired by default (event unpinned)');
  assert.deepEqual(
    Object.keys(base.hooks).sort(),
    ['afterFileEdit', 'beforeShellExecution', 'preToolUse'],
    'default hooks.json contains ONLY verified events',
  );

  const optIn = mergeHooks(base, undefined, { wireUnpinned: true });
  assert.match(optIn.hooks.stop[0].command, /adlc-stop\.mjs/);
  assert.match(optIn.hooks.beforeSubmitPrompt[0].command, /adlc-preflight\.mjs/);
  // idempotent under the flag
  const optInTwice = mergeHooks(optIn, undefined, { wireUnpinned: true });
  assert.equal(optInTwice.hooks.stop.filter((e) => /adlc-stop/.test(e.command)).length, 1);

  // un-flagging restores the verified-events-only default; user entries survive
  const withUser = mergeHooks({ ...optIn, hooks: { ...optIn.hooks, stop: [...optIn.hooks.stop, { command: './mine.sh' }] } });
  assert.ok(!(withUser.hooks.stop ?? []).some((e) => /adlc-stop/.test(e.command)), 'our stop entry is removed without the flag');
  assert.ok(withUser.hooks.stop.some((e) => e.command === './mine.sh'), 'the user stop entry is preserved');
});

test('ensureCursorHooks honors the wireUnpinned option end-to-end', () => {
  const root = mkRepo();
  ensureCursorHooks(root, { wireUnpinned: true });
  let hooks = readJson(join(root, '.cursor', 'hooks.json'));
  assert.match(hooks.hooks.stop[0].command, /adlc-stop\.mjs/);
  assert.match(hooks.hooks.beforeSubmitPrompt[0].command, /adlc-preflight\.mjs/);
  // re-running without the flag restores the disabled default
  ensureCursorHooks(root, { wireUnpinned: false });
  hooks = readJson(join(root, '.cursor', 'hooks.json'));
  assert.equal(hooks.hooks.stop, undefined);
  assert.equal(hooks.hooks.beforeSubmitPrompt, undefined);
});

test('ensureCursorHooks BACKS UP an unparseable existing hooks.json instead of dropping it', () => {
  const root = mkRepo();
  mkdirSync(join(root, '.cursor'), { recursive: true });
  const original = '{ not json — a company hook lived here';
  writeFileSync(join(root, '.cursor', 'hooks.json'), original);
  const res = ensureCursorHooks(root);
  // ADLC hook is installed...
  const hooks = readJson(join(root, '.cursor', 'hooks.json'));
  assert.match(hooks.hooks.preToolUse[0].command, /adlc-pretool/);
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

// T16 AC1: the package ships command/*.md, but until now the scaffolder never
// deployed them — docs claimed /adlc-init was runnable inside Cursor while
// .cursor/commands/ did not exist. scaffold() must land EVERY shipped command.
test('scaffold() deploys every packaged command/*.md into .cursor/commands/ (T16 AC1)', () => {
  const root = mkRepo();
  const out = scaffold(root);
  const shipped = readdirSync(join(PLUGIN_ROOT, 'command')).filter((f) => f.endsWith('.md'));
  assert.ok(shipped.length > 0, 'the package must ship at least one command');
  for (const name of shipped) {
    const dest = join(root, '.cursor', 'commands', name);
    assert.ok(existsSync(dest), `${name} must be deployed to .cursor/commands/`);
    assert.equal(
      readFileSync(dest, 'utf8'),
      readFileSync(join(PLUGIN_ROOT, 'command', name), 'utf8'),
      `${name} must match the package source byte-for-byte`,
    );
  }
  assert.deepEqual([...out.commands].sort(), [...shipped].sort(), 'scaffold() reports the deployed commands');
});

// T16 AC2: re-running is idempotent — the package source wins over a drifted
// deployed copy, no duplicates appear, and unrelated user files survive.
test('scaffold() command deployment is idempotent: package source wins, unrelated files survive (T16 AC2)', () => {
  const root = mkRepo();
  scaffold(root);
  const cmdDir = join(root, '.cursor', 'commands');
  const shipped = readdirSync(join(PLUGIN_ROOT, 'command')).filter((f) => f.endsWith('.md'));
  const first = shipped[0];
  // Drift a deployed command and plant an unrelated user command.
  writeFileSync(join(cmdDir, first), 'user-drifted content\n');
  writeFileSync(join(cmdDir, 'my-team-command.md'), '---\ndescription: not ours\n---\nkeep me\n');

  scaffold(root);

  assert.equal(
    readFileSync(join(cmdDir, first), 'utf8'),
    readFileSync(join(PLUGIN_ROOT, 'command', first), 'utf8'),
    're-run must restore the package source (package is the source of truth)',
  );
  assert.equal(
    readFileSync(join(cmdDir, 'my-team-command.md'), 'utf8'),
    '---\ndescription: not ours\n---\nkeep me\n',
    're-run must never delete or rewrite unrelated files',
  );
  const deployed = readdirSync(cmdDir).filter((f) => f.endsWith('.md'));
  assert.equal(deployed.length, shipped.length + 1, 'no duplicates on re-run');
});

