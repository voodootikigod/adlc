import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, TicketService } from '../index.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

const git = (cwd, args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

test('parallel branches adding different ticket shards merge without conflict', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-merge-'));
  const left = `${root}-left`;
  const right = `${root}-right`;
  try {
    git(root, ['init', '-b', 'main']); git(root, ['config', 'user.email', 'test@example.com']); git(root, ['config', 'user.name', 'Test']);
    writeDirectory(root, [ticket('BASE')]); git(root, ['add', '.']); git(root, ['commit', '-m', 'base']);
    git(root, ['worktree', 'add', '-b', 'left', left, 'main']);
    git(root, ['worktree', 'add', '-b', 'right', right, 'main']);
    for (const [worktree, id] of [[left, 'LEFT'], [right, 'RIGHT']]) {
      const store = new DirectoryTicketStore(join(worktree, '.adlc/tickets'));
      const service = new TicketService(store, { root: worktree });
      service.apply(service.planCreate(ticket(id)));
      git(worktree, ['add', '.adlc/tickets']); git(worktree, ['commit', '-m', `add ${id}`]);
    }
    git(root, ['merge', '--no-edit', 'left']);
    git(root, ['merge', '--no-edit', 'right']);
    const ids = new DirectoryTicketStore(join(root, '.adlc/tickets')).load().tickets.map((item) => item.id).sort();
    assert.deepEqual(ids, ['BASE', 'LEFT', 'RIGHT']);
  } finally {
    try { git(root, ['worktree', 'remove', '--force', left]); } catch {}
    try { git(root, ['worktree', 'remove', '--force', right]); } catch {}
    rmSync(root, { recursive: true, force: true });
    rmSync(left, { recursive: true, force: true });
    rmSync(right, { recursive: true, force: true });
  }
});

test('parallel branches editing the same shard retain a normal Git conflict', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-same-shard-'));
  const left = `${root}-left`;
  const right = `${root}-right`;
  try {
    git(root, ['init', '-b', 'main']); git(root, ['config', 'user.email', 'test@example.com']); git(root, ['config', 'user.name', 'Test']);
    writeDirectory(root, [ticket('SAME')]); git(root, ['add', '.']); git(root, ['commit', '-m', 'base']);
    git(root, ['worktree', 'add', '-b', 'left', left, 'main']);
    git(root, ['worktree', 'add', '-b', 'right', right, 'main']);
    for (const [worktree, title] of [[left, 'Left title'], [right, 'Right title']]) {
      const store = new DirectoryTicketStore(join(worktree, '.adlc/tickets'));
      const service = new TicketService(store, { root: worktree });
      const before = store.load();
      service.apply(service.planUpdate('SAME', { ...before.get('SAME'), title }, { expect: before.ticketHashes.SAME }));
      git(worktree, ['add', '.adlc/tickets']); git(worktree, ['commit', '-m', title]);
    }
    git(root, ['merge', '--no-edit', 'left']);
    const merge = spawnSync('git', ['-c', 'commit.gpgsign=false', 'merge', '--no-edit', 'right'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(merge.status, 0);
    assert.match(`${merge.stdout}\n${merge.stderr}`, /conflict/i);
  } finally {
    try { spawnSync('git', ['merge', '--abort'], { cwd: root }); } catch {}
    try { git(root, ['worktree', 'remove', '--force', left]); } catch {}
    try { git(root, ['worktree', 'remove', '--force', right]); } catch {}
    rmSync(root, { recursive: true, force: true });
    rmSync(left, { recursive: true, force: true });
    rmSync(right, { recursive: true, force: true });
  }
});
