import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseLsTreeZ, parseLogNameOnlyZ, createRevisionIndex } from '../lib/verify.mjs';
import { groom } from '../lib/groom.mjs';

test('parseLsTreeZ parses blob, tree, and commit entries and ignores malformed records', () => {
  const raw = [
    '040000 tree aaa111\tpackages',
    '100644 blob bbb222\tpackages/a.mjs',
    '160000 commit ccc333\tvendor/sub',
    'malformed-no-tab',
    '',
  ].join('\0');
  const kinds = parseLsTreeZ(raw);
  assert.equal(kinds.get('packages'), 'tree');
  assert.equal(kinds.get('packages/a.mjs'), 'blob');
  assert.equal(kinds.get('vendor/sub'), 'commit');
  assert.equal(kinds.size, 3);
});

test('parseLogNameOnlyZ keeps newest commit per path and indexes ancestor directories', () => {
  const raw = [
    'orphan-before-sha',
    '\x1enew111',
    '\npackages/foo/bar.mjs',
    'packages/foo/baz.mjs',
    '\x1eold222',
    '\npackages/foo/bar.mjs',
    'deleted/old.mjs',
    '',
  ].join('\0');
  const { lastCommitByPath, everExistedPaths } = parseLogNameOnlyZ(raw);
  assert.equal(lastCommitByPath.get('packages/foo/bar.mjs'), 'new111');
  assert.equal(lastCommitByPath.get('packages/foo/baz.mjs'), 'new111');
  assert.equal(lastCommitByPath.get('deleted/old.mjs'), 'old222');
  assert.equal(lastCommitByPath.has('orphan-before-sha'), false);
  assert.equal(everExistedPaths.has('packages/foo/bar.mjs'), true);
  assert.equal(everExistedPaths.has('packages/foo'), true);
  assert.equal(everExistedPaths.has('packages'), true);
  assert.equal(everExistedPaths.has('deleted'), true);
  assert.equal(everExistedPaths.has('never/existed.mjs'), false);
});

test('createRevisionIndex performs exactly 2 git spawns against real repo and answers O(1) lookups', () => {
  const calls = [];
  const spyRun = (bin, args, opts) => {
    calls.push([bin, ...args]);
    return execFileSync(bin, args, opts);
  };

  const idx = createRevisionIndex('HEAD', spyRun);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['git', 'ls-tree', '-r', '-t', '-z', 'HEAD']);
  assert.deepEqual(calls[1], ['git', 'log', '--format=%x1e%h', '--name-only', '-z', 'HEAD']);

  assert.equal(idx.pathKind('packages/backlog-groom/package.json'), 'blob');
  assert.equal(idx.pathKind('packages/backlog-groom/lib'), 'tree');
  assert.equal(idx.pathKind('packages/backlog-groom/lib/'), 'tree');
  assert.equal(idx.pathKind('does/not/exist.mjs'), null);

  const sha = idx.lastCommitFor('packages/backlog-groom/package.json');
  assert.match(String(sha), /^[0-9a-f]{7,}$/);
  assert.equal(idx.lastCommitFor('does/not/exist.mjs'), null);

  assert.equal(idx.everExisted('packages/backlog-groom/package.json'), true);
  assert.equal(idx.everExisted('packages/backlog-groom/lib'), true);
  assert.equal(idx.everExisted('does/not/exist.mjs'), false);

  // Zero additional spawns after index creation.
  assert.equal(calls.length, 2);
});

test('createRevisionIndex falls back cleanly to per-path git queries when batch queries fail', () => {
  const calls = [];
  const flakyRun = (bin, args) => {
    calls.push(args);
    if (args[0] === 'ls-tree' || (args[0] === 'log' && args.includes('--name-only'))) {
      throw new Error('batch failed');
    }
    if (args[0] === 'cat-file') return 'blob\n';
    if (args[0] === 'log' && args.includes('--format=%h')) return 'abc1234\n';
    if (args[0] === 'log' && args.includes('--oneline')) return 'abc1234 msg\n';
    return '';
  };

  const idx = createRevisionIndex('HEAD', flakyRun);
  assert.equal(idx.pathKind('a.mjs'), 'blob');
  assert.equal(idx.lastCommitFor('a.mjs'), 'abc1234');
  assert.equal(idx.everExisted('a.mjs'), true);
  assert.ok(calls.some((a) => a[0] === 'cat-file'));
  assert.ok(calls.some((a) => a[0] === 'log' && a.includes('--format=%h')));
  assert.ok(calls.some((a) => a[0] === 'log' && a.includes('--oneline')));
});

test('groom() builds the revision index once per run (2 git spawns across multiple issues)', () => {
  const calls = [];
  const fakeRun = (_bin, args) => {
    calls.push(args);
    if (args[0] === 'ls-tree') {
      return '100644 blob aaa\tlib/a.mjs\x00100644 blob bbb\tlib/b.mjs\x00';
    }
    if (args[0] === 'log' && args.includes('--name-only')) {
      return '\x1edeadbee\x00\nlib/a.mjs\x00lib/b.mjs\x00lib/gone.mjs\x00';
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };

  const profile = {
    units: [],
    labels: { priority: {} },
    frozenPaths: [],
  };
  const issues = [
    {
      number: 1,
      title: 'Issue 1',
      body: 'In `lib/a.mjs:1`:\n```js\nconst a = 1;\n```',
      labels: [],
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      number: 2,
      title: 'Issue 2',
      body: 'In `lib/b.mjs:1`:\n```js\nconst b = 2;\n```',
      labels: [],
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
  const files = { 'lib/a.mjs': 'const a = 1;\n', 'lib/b.mjs': 'const b = 999;\n' };
  const res = groom({
    profile,
    generatedFor: 'deadbeef',
    io: {
      fetchIssues: () => ({ issues, unconsultable: null, truncated: false }),
      readFile: (p) => files[p],
      run: fakeRun,
    },
  });

  assert.equal(res.ok, true);
  assert.equal(calls.length, 2, 'groom must run only ls-tree and log once across all issues');
  assert.equal(res.rows[0].verified.verdict, 'valid');
  assert.equal(res.rows[1].verified.verdict, 'fixed');
  assert.equal(res.rows[1].verified.evidence.lastCommitTouchingPath, 'deadbee');

  // Single-issue sweep also builds the revision index (kills issues.length > 0 -> > 1).
  calls.length = 0;
  const singleRes = groom({
    profile,
    generatedFor: 'deadbeef',
    io: {
      fetchIssues: () => ({ issues: [issues[0]], unconsultable: null, truncated: false }),
      readFile: (p) => files[p],
      run: fakeRun,
    },
  });
  assert.equal(singleRes.ok, true);
  assert.equal(calls.length, 2, 'single-issue groom must also use the 2-spawn revision index');
});
