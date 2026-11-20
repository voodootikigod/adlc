import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo } from '../lib/test-kit.mjs';
import { untrackedNonIgnoredPaths } from '../lib/revision.mjs';

test('untrackedNonIgnoredPaths treats unsuffixed ignorePaths as exact leaf matches while preserving trailing-slash directory ignores and DEFAULT_IGNORED_PATHS', (t) => {
  const { dir, git } = gitRepo(t);
  writeFileSync(join(dir, 'tracked.txt'), 'hello\n');
  git('add', 'tracked.txt');
  git('commit', '-m', 'init');

  writeFileSync(join(dir, 'leaf.txt'), 'content\n');
  mkdirSync(join(dir, 'leaf-dir'));
  writeFileSync(join(dir, 'leaf-dir', 'nested.txt'), 'nested\n');
  mkdirSync(join(dir, 'explicit-dir'));
  writeFileSync(join(dir, 'explicit-dir', 'child.txt'), 'child\n');

  mkdirSync(join(dir, '.adlc', 'tickets'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets', 'T-001.json'), '{}\n');

  mkdirSync(join(dir, '.adlc', 'ticket-archive'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'ticket-archive', 'archived.json'), '{}\n');

  mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'manifest.d', 'fragment.json'), '{}\n');
  mkdirSync(join(dir, 'manifest.d'), { recursive: true });
  writeFileSync(join(dir, 'manifest.d', 'root-seg.jsonl'), '{}\n');

  writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'manifest\n');
  writeFileSync(join(dir, 'untracked-normal.txt'), 'normal\n');

  const untracked = untrackedNonIgnoredPaths({
    cwd: dir,
    ignorePaths: ['leaf.txt', 'leaf-dir', 'explicit-dir/', '.adlc/manifest.d', 'manifest.d'],
  });

  assert.ok(untracked.includes('leaf-dir/nested.txt'), 'unsuffixed ignorePaths must not match directory children');
  assert.ok(untracked.includes('untracked-normal.txt'), 'untracked-normal.txt must be reported');

  assert.ok(!untracked.includes('leaf.txt'), 'leaf.txt exact match must be ignored');
  assert.ok(!untracked.includes('explicit-dir/child.txt'), 'explicit-dir/ trailing slash must ignore children');
  assert.ok(!untracked.includes('.adlc/tickets/T-001.json'), '.adlc/tickets must be ignored via DEFAULT_IGNORED_PATHS');
  assert.ok(!untracked.includes('.adlc/ticket-archive/archived.json'), '.adlc/ticket-archive must be ignored via DEFAULT_IGNORED_PATHS');
  assert.ok(!untracked.includes('.adlc/manifest.d/fragment.json'), '.adlc/manifest.d must be ignored');
  assert.ok(!untracked.includes('manifest.d/root-seg.jsonl'), 'top-level manifest.d must be ignored');
  assert.ok(!untracked.includes('.adlc/manifest.jsonl'), '.adlc/manifest.jsonl must be ignored via DEFAULT_IGNORED_PATHS');
});
