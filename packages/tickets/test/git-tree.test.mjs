import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitTreeTicketStore } from '../index.mjs';
import { ticket, writeDirectory, writeLegacy } from './helpers.mjs';

const git = (cwd, args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

test('GitTreeTicketStore reads exact legacy and directory revisions without worktree fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-git-'));
  try {
    git(root, ['init']); git(root, ['config', 'user.email', 'test@example.com']); git(root, ['config', 'user.name', 'Test']);
    writeLegacy(root, [ticket('A')]); git(root, ['add', '.']); git(root, ['commit', '-m', 'legacy']);
    const legacyRevision = git(root, ['rev-parse', 'HEAD']);
    rmSync(join(root, '.adlc/tickets.json'));
    writeDirectory(root, [ticket('A'), ticket('B')]); git(root, ['add', '-A']); git(root, ['commit', '-m', 'directory']);
    const directoryRevision = git(root, ['rev-parse', 'HEAD']);
    assert.deepEqual(new GitTreeTicketStore({ cwd: root, revision: legacyRevision }).load().tickets.map((item) => item.id), ['A']);
    assert.deepEqual(new GitTreeTicketStore({ cwd: root, revision: directoryRevision }).load().tickets.map((item) => item.id), ['A', 'B']);
    writeLegacy(root, [ticket('HOSTILE')]);
    assert.deepEqual(new GitTreeTicketStore({ cwd: root, revision: directoryRevision }).load().tickets.map((item) => item.id), ['A', 'B']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GitTreeTicketStore rejects symlink and executable JSON entries from an exact revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-git-mode-'));
  try {
    git(root, ['init']); git(root, ['config', 'user.email', 'test@example.com']); git(root, ['config', 'user.name', 'Test']);
    writeDirectory(root, [ticket('A')]);
    git(root, ['add', '.']); git(root, ['commit', '-m', 'directory']);
    const shard = git(root, ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.adlc/tickets']).split('\n').find((path) => path !== '.adlc/tickets/.store.json');
    rmSync(join(root, shard));
    symlinkSync('.store.json', join(root, shard));
    git(root, ['add', '-A']); git(root, ['commit', '-m', 'symlink shard']);
    assert.throws(() => new GitTreeTicketStore({ cwd: root, revision: 'HEAD' }).load(), { code: 'UNSAFE_GIT_MODE' });

    rmSync(join(root, shard));
    writeFileSync(join(root, shard), `${JSON.stringify(ticket('A'))}\n`, { mode: 0o755 });
    git(root, ['add', '-A']); git(root, ['update-index', '--chmod=+x', shard]); git(root, ['commit', '-m', 'executable shard']);
    assert.throws(() => new GitTreeTicketStore({ cwd: root, revision: 'HEAD' }).load(), { code: 'UNSAFE_GIT_MODE' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GitTreeTicketStore rejects option-like revisions and resolves moving refs once', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-git-revision-'));
  try {
    git(root, ['init']); git(root, ['config', 'user.email', 'test@example.com']); git(root, ['config', 'user.name', 'Test']);
    writeLegacy(root, [ticket('A')]); git(root, ['add', '.']); git(root, ['commit', '-m', 'first']);
    assert.throws(() => new GitTreeTicketStore({ cwd: root, revision: '--help' }), { code: 'UNSAFE_GIT_REVISION' });
    const store = new GitTreeTicketStore({ cwd: root, revision: 'HEAD' });
    assert.deepEqual(store.load().tickets.map((item) => item.id), ['A']);
    writeLegacy(root, [ticket('B')]); git(root, ['add', '.']); git(root, ['commit', '-m', 'second']);
    assert.deepEqual(store.load().tickets.map((item) => item.id), ['B']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
