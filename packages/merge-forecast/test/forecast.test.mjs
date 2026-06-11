/**
 * Tests for merge-forecast.
 *
 * All tests run offline and use temp directories.
 * Git repos are initialized with synthetic commits for co-change tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  parallelEligiblePairs,
  topoWaves,
} from '../lib/reachability.mjs';

import {
  signalScopeOverlap,
  signalImportRadius,
  signalCoChange,
  signalNamespaceRoutes,
  signalMigrationCollision,
  walkTree,
  pairScore,
} from '../lib/signals.mjs';

import { pairKey } from '../../core/index.mjs';

import { runForecast } from '../lib/forecast.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mkTemp() {
  return mkdtempSync(join(tmpdir(), 'mf-test-'));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function mkTicket(id, opts = {}) {
  return { id, title: `Ticket ${id}`, ...opts };
}

function writeFile(root, relPath, content = '') {
  const full = join(root, relPath);
  mkdirSync(join(root, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function gitInit(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
}

function gitCommit(dir, files, message) {
  for (const [relPath, content] of Object.entries(files)) {
    writeFile(dir, relPath, content);
    execFileSync('git', ['add', relPath], { cwd: dir, stdio: 'ignore' });
  }
  execFileSync('git', ['commit', '-m', message, '--allow-empty'], { cwd: dir, stdio: 'ignore' });
}

// ─── Reachability tests ───────────────────────────────────────────────────────

describe('parallelEligiblePairs', () => {
  test('no edges — all pairs are parallel-eligible', () => {
    const tickets = [mkTicket('A'), mkTicket('B'), mkTicket('C')];
    const pairs = parallelEligiblePairs(tickets);
    assert.equal(pairs.length, 3);
  });

  test('A → B edge — A and B not parallel-eligible', () => {
    const tickets = [
      mkTicket('A', { edges: [{ to: 'B', contract: '' }] }),
      mkTicket('B'),
    ];
    const pairs = parallelEligiblePairs(tickets);
    assert.equal(pairs.length, 0);
  });

  test('A → B, C independent — [A,C] and [B,C] are parallel-eligible', () => {
    const tickets = [
      mkTicket('A', { edges: [{ to: 'B', contract: '' }] }),
      mkTicket('B'),
      mkTicket('C'),
    ];
    const pairs = parallelEligiblePairs(tickets);
    const pairIds = pairs.map(([a, b]) => `${a.id}-${b.id}`);
    assert.ok(pairIds.includes('A-C') || pairIds.includes('C-A'));
    assert.ok(pairIds.includes('B-C') || pairIds.includes('C-B'));
    // A and B should NOT be in pairs
    assert.ok(!pairIds.includes('A-B') && !pairIds.includes('B-A'));
  });

  test('transitive dependency excluded', () => {
    const tickets = [
      mkTicket('A', { edges: [{ to: 'B', contract: '' }] }),
      mkTicket('B', { edges: [{ to: 'C', contract: '' }] }),
      mkTicket('C'),
    ];
    const pairs = parallelEligiblePairs(tickets);
    // A→B→C: no pairs are parallel-eligible
    assert.equal(pairs.length, 0);
  });
});

describe('topoWaves', () => {
  test('no edges — one wave with all tickets', () => {
    const tickets = [mkTicket('A'), mkTicket('B'), mkTicket('C')];
    const waves = topoWaves(tickets);
    assert.equal(waves.length, 1);
    assert.deepEqual([...waves[0]].sort(), ['A', 'B', 'C']);
  });

  test('A → B: two waves', () => {
    const tickets = [
      mkTicket('A', { edges: [{ to: 'B', contract: '' }] }),
      mkTicket('B'),
    ];
    const waves = topoWaves(tickets);
    assert.equal(waves.length, 2);
    assert.deepEqual(waves[0], ['A']);
    assert.deepEqual(waves[1], ['B']);
  });

  test('diamond: A→B, A→C, B→D, C→D', () => {
    const tickets = [
      mkTicket('A', { edges: [{ to: 'B' }, { to: 'C' }] }),
      mkTicket('B', { edges: [{ to: 'D' }] }),
      mkTicket('C', { edges: [{ to: 'D' }] }),
      mkTicket('D'),
    ];
    const waves = topoWaves(tickets);
    assert.equal(waves.length, 3);
    assert.deepEqual(waves[0], ['A']);
    assert.equal(waves[1].length, 2); // B and C
    assert.ok(waves[1].includes('B') && waves[1].includes('C'));
    assert.deepEqual(waves[2], ['D']);
  });
});

// ─── Signal tests ─────────────────────────────────────────────────────────────

describe('signalScopeOverlap', () => {
  test('identical globs → 1.0', () => {
    const a = mkTicket('A', { scope: ['src/auth/**'] });
    const b = mkTicket('B', { scope: ['src/auth/**'] });
    assert.equal(signalScopeOverlap(a, b), 1.0);
  });

  test('overlapping prefix globs → 1.0', () => {
    const a = mkTicket('A', { scope: ['src/**'] });
    const b = mkTicket('B', { scope: ['src/auth/**'] });
    assert.equal(signalScopeOverlap(a, b), 1.0);
  });

  test('disjoint scopes → 0', () => {
    const a = mkTicket('A', { scope: ['src/auth/**'] });
    const b = mkTicket('B', { scope: ['src/billing/**'] });
    assert.equal(signalScopeOverlap(a, b), 0);
  });

  test('no scope → 0', () => {
    const a = mkTicket('A');
    const b = mkTicket('B');
    assert.equal(signalScopeOverlap(a, b), 0);
  });
});

describe('signalImportRadius', () => {
  test('A imports from B scope → 0.6', () => {
    const root = mkTemp();
    try {
      writeFile(root, 'src/auth/index.js', "import { foo } from '../billing/foo.js';\n");
      writeFile(root, 'src/billing/foo.js', 'export const foo = 1;\n');

      const repoFiles = walkTree(root);
      const a = mkTicket('A', { scope: ['src/auth/**'] });
      const b = mkTicket('B', { scope: ['src/billing/**'] });

      const score = signalImportRadius(a, b, repoFiles, root);
      assert.equal(score, 0.6);
    } finally {
      cleanup(root);
    }
  });

  test('no cross-imports → 0', () => {
    const root = mkTemp();
    try {
      writeFile(root, 'src/auth/index.js', "import { x } from 'external-pkg';\n");
      writeFile(root, 'src/billing/foo.js', 'export const foo = 1;\n');

      const repoFiles = walkTree(root);
      const a = mkTicket('A', { scope: ['src/auth/**'] });
      const b = mkTicket('B', { scope: ['src/billing/**'] });

      const score = signalImportRadius(a, b, repoFiles, root);
      assert.equal(score, 0);
    } finally {
      cleanup(root);
    }
  });
});

describe('signalCoChange', () => {
  test('correlated files → non-zero score', () => {
    const pairCounts = { [pairKey('src/a.js', 'src/b.js')]: 5 };
    const fileCounts = { 'src/a.js': 10, 'src/b.js': 10 };
    const a = mkTicket('A', { scope: ['src/a.js'] });
    const b = mkTicket('B', { scope: ['src/b.js'] });
    const repoFiles = ['src/a.js', 'src/b.js'];

    const score = signalCoChange(a, b, { pairCounts, fileCounts }, repoFiles);
    // 5/10 * 0.5 = 0.25
    assert.equal(score, 0.25);
  });

  test('no cochange data → 0', () => {
    const a = mkTicket('A', { scope: ['src/a.js'] });
    const b = mkTicket('B', { scope: ['src/b.js'] });
    const score = signalCoChange(a, b, null, ['src/a.js', 'src/b.js']);
    assert.equal(score, 0);
  });

  test('score capped at 0.5', () => {
    const pairCounts = { [pairKey('src/a.js', 'src/b.js')]: 100 };
    const fileCounts = { 'src/a.js': 5, 'src/b.js': 5 };
    const a = mkTicket('A', { scope: ['src/a.js'] });
    const b = mkTicket('B', { scope: ['src/b.js'] });
    const repoFiles = ['src/a.js', 'src/b.js'];

    const score = signalCoChange(a, b, { pairCounts, fileCounts }, repoFiles);
    assert.equal(score, 0.5); // capped
  });
});

describe('signalNamespaceRoutes', () => {
  test('detects [pk] vs [voteKey] at same depth → true', () => {
    const repoFiles = [
      'app/votes/[pk]/page.tsx',
      'app/votes/[voteKey]/details.tsx',
    ];
    const a = mkTicket('A', { scope: ['app/votes/[pk]/**'] });
    const b = mkTicket('B', { scope: ['app/votes/[voteKey]/**'] });

    const result = signalNamespaceRoutes(a, b, repoFiles);
    assert.equal(result, true);
  });

  test('same bracket name at same depth → no collision', () => {
    const repoFiles = [
      'app/votes/[id]/page.tsx',
      'app/items/[id]/page.tsx',
    ];
    const a = mkTicket('A', { scope: ['app/votes/**'] });
    const b = mkTicket('B', { scope: ['app/items/**'] });

    const result = signalNamespaceRoutes(a, b, repoFiles);
    assert.equal(result, false);
  });

  test('no route files → no collision', () => {
    const repoFiles = ['src/auth/index.js', 'src/billing/index.js'];
    const a = mkTicket('A', { scope: ['src/auth/**'] });
    const b = mkTicket('B', { scope: ['src/billing/**'] });

    const result = signalNamespaceRoutes(a, b, repoFiles);
    assert.equal(result, false);
  });
});

describe('signalMigrationCollision', () => {
  test('same migration prefix → collision', () => {
    const repoFiles = [
      'drizzle/0005_add_users.sql',
      'migrations/0005_add_votes.sql',
    ];
    const a = mkTicket('A', { scope: ['drizzle/**'] });
    const b = mkTicket('B', { scope: ['migrations/**'] });

    const result = signalMigrationCollision(a, b, repoFiles);
    assert.equal(result, true);
  });

  test('different migration prefixes → no collision', () => {
    const repoFiles = [
      'drizzle/0004_add_users.sql',
      'drizzle/0005_add_votes.sql',
    ];
    const a = mkTicket('A', { scope: ['drizzle/0004*'] });
    const b = mkTicket('B', { scope: ['drizzle/0005*'] });

    const result = signalMigrationCollision(a, b, repoFiles);
    assert.equal(result, false);
  });
});

describe('pairScore — hard veto', () => {
  test('scope overlap → 1.0 HARD VETO', () => {
    const a = mkTicket('A', { scope: ['src/auth/**'] });
    const b = mkTicket('B', { scope: ['src/auth/**'] });
    const { score, signal, hardVeto } = pairScore(a, b, { repoFiles: [], root: '/' });
    assert.equal(score, 1.0);
    assert.equal(signal, 'scope-overlap');
    assert.equal(hardVeto, true);
  });
});

// ─── runForecast integration tests ───────────────────────────────────────────

describe('runForecast', () => {
  test('single ticket — no pairs, width=1', async () => {
    const root = mkTemp();
    try {
      gitInit(root);
      gitCommit(root, { 'src/a.js': '// a' }, 'init');

      const tickets = [mkTicket('T1', { scope: ['src/a.js'] })];
      const result = await runForecast({ tickets, root });

      assert.equal(result.pairs.length, 0);
      assert.equal(result.certifiedWidth, 1);
      assert.equal(result.gateFailures.length, 0);
    } finally {
      cleanup(root);
    }
  });

  test('two disjoint tickets — PARALLEL verdict', async () => {
    const root = mkTemp();
    try {
      gitInit(root);
      // Create files in separate commits so they have no co-change coupling
      gitCommit(root, { 'src/auth/index.js': '// auth' }, 'init auth');
      gitCommit(root, { 'src/billing/index.js': '// billing' }, 'init billing');

      const tickets = [
        mkTicket('T1', { scope: ['src/auth/**'] }),
        mkTicket('T2', { scope: ['src/billing/**'] }),
      ];
      const result = await runForecast({ tickets, root });

      assert.equal(result.pairs.length, 1);
      assert.equal(result.pairs[0].verdict, 'PARALLEL');
      assert.equal(result.gateFailures.length, 0);
    } finally {
      cleanup(root);
    }
  });

  test('scope overlap → VETO, concurrent in wave 1 → gateFail', async () => {
    const root = mkTemp();
    try {
      gitInit(root);
      gitCommit(root, { 'src/auth/index.js': '// auth' }, 'init');

      const tickets = [
        mkTicket('T1', { scope: ['src/auth/**'] }),
        mkTicket('T2', { scope: ['src/auth/**'] }),
      ];
      const result = await runForecast({ tickets, root, conflictThreshold: 0.5 });

      assert.equal(result.pairs[0].verdict, 'VETO');
      assert.ok(result.gateFailures.length > 0);
    } finally {
      cleanup(root);
    }
  });

  test('--width > certifiedWidth → gateFail', async () => {
    const root = mkTemp();
    try {
      gitInit(root);
      gitCommit(
        root,
        { 'src/auth/index.js': '// a', 'src/billing/index.js': '// b' },
        'init'
      );

      const tickets = [
        mkTicket('T1', { scope: ['src/auth/**'] }),
        mkTicket('T2', { scope: ['src/billing/**'] }),
      ];
      // certifiedWidth will be 2 (two disjoint tickets in wave 1)
      // Request width=10 which should fail
      const result = await runForecast({ tickets, root, width: 10 });

      assert.ok(result.gateFailures.some((f) => f.includes('certifiedWidth')));
    } finally {
      cleanup(root);
    }
  });

  test('backpressure width computed correctly', async () => {
    const root = mkTemp();
    try {
      gitInit(root);
      gitCommit(root, { 'src/a.js': '// a' }, 'init');

      const tickets = [mkTicket('T1', { scope: ['src/a.js'] })];
      const result = await runForecast({
        tickets,
        root,
        buildMin: 20,
        mergeMin: 4,
      });

      assert.equal(result.backpressureWidth, 5); // round(20/4) = 5
    } finally {
      cleanup(root);
    }
  });

  test('namespace collision → 0.8 score', async () => {
    const root = mkTemp();
    try {
      gitInit(root);
      mkdirSync(join(root, 'app/votes/[pk]'), { recursive: true });
      mkdirSync(join(root, 'app/votes/[voteKey]'), { recursive: true });
      writeFileSync(join(root, 'app/votes/[pk]/page.tsx'), '// pk page');
      writeFileSync(join(root, 'app/votes/[voteKey]/details.tsx'), '// voteKey details');
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], { cwd: root, stdio: 'ignore' });

      const tickets = [
        mkTicket('T1', { scope: ['app/votes/[pk]/**'] }),
        mkTicket('T2', { scope: ['app/votes/[voteKey]/**'] }),
      ];
      const result = await runForecast({ tickets, root, conflictThreshold: 0.5 });

      const pair = result.pairs[0];
      assert.ok(pair.score >= 0.8, `Expected score >= 0.8, got ${pair.score}`);
      assert.equal(pair.signal, 'namespace-collision');
    } finally {
      cleanup(root);
    }
  });

  test('co-change integration: correlated files raise score', async () => {
    const root = mkTemp();
    try {
      gitInit(root);
      // Create multiple commits where auth and billing co-change
      for (let i = 0; i < 8; i++) {
        gitCommit(
          root,
          {
            'src/auth/index.js': `// auth v${i}`,
            'src/billing/index.js': `// billing v${i}`,
          },
          `co-change commit ${i}`
        );
      }
      // Add a few solo auth commits to lower fileCounts ratio
      for (let i = 0; i < 2; i++) {
        gitCommit(root, { 'src/auth/index.js': `// auth solo ${i}` }, `auth solo ${i}`);
      }

      const tickets = [
        mkTicket('T1', { scope: ['src/auth/**'] }),
        mkTicket('T2', { scope: ['src/billing/**'] }),
      ];
      const result = await runForecast({ tickets, root, conflictThreshold: 0.5 });

      const pair = result.pairs[0];
      // co-change score: 8/10 * 0.5 = 0.4 (billing fileCounts=8, auth=10, min=8)
      // 8/8 * 0.5 = 0.5
      assert.ok(pair.score > 0, `Expected non-zero score, got ${pair.score}`);
      assert.ok(['co-change', 'namespace-collision', 'import-radius'].includes(pair.signal));
    } finally {
      cleanup(root);
    }
  });

  test('DAG edges — downstream ticket in wave 2', async () => {
    const root = mkTemp();
    try {
      gitInit(root);
      gitCommit(root, { 'src/a.js': '// a', 'src/b.js': '// b' }, 'init');

      const tickets = [
        mkTicket('T1', { scope: ['src/a.js'], edges: [{ to: 'T2', contract: 'src/a.js' }] }),
        mkTicket('T2', { scope: ['src/b.js'] }),
      ];
      const result = await runForecast({ tickets, root });

      // T1 and T2 are not parallel-eligible (T1 → T2)
      assert.equal(result.pairs.length, 0);
      assert.equal(result.waves.length, 2);
      assert.deepEqual(result.waves[0], ['T1']);
      assert.deepEqual(result.waves[1], ['T2']);
    } finally {
      cleanup(root);
    }
  });

  test('degrades gracefully when not a git repo (co-change skipped)', async () => {
    const root = mkTemp();
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/a.js'), '// a');
      writeFileSync(join(root, 'src/b.js'), '// b');

      const tickets = [
        mkTicket('T1', { scope: ['src/a.js'] }),
        mkTicket('T2', { scope: ['src/b.js'] }),
      ];

      // Should NOT throw
      const result = await runForecast({ tickets, root });
      assert.ok(result.warnings.some((w) => w.includes('co-change skipped')));
    } finally {
      cleanup(root);
    }
  });

  test('migration prefix collision detected', async () => {
    const root = mkTemp();
    try {
      gitInit(root);
      mkdirSync(join(root, 'drizzle'), { recursive: true });
      mkdirSync(join(root, 'migrations'), { recursive: true });
      writeFileSync(join(root, 'drizzle/0005_add_users.sql'), '-- users');
      writeFileSync(join(root, 'migrations/0005_add_votes.sql'), '-- votes');
      execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], { cwd: root, stdio: 'ignore' });

      const tickets = [
        mkTicket('T1', { scope: ['drizzle/**'] }),
        mkTicket('T2', { scope: ['migrations/**'] }),
      ];
      const result = await runForecast({ tickets, root, conflictThreshold: 0.5 });

      const pair = result.pairs[0];
      assert.ok(pair.score >= 0.8);
      assert.equal(pair.signal, 'namespace-collision');
    } finally {
      cleanup(root);
    }
  });
});

// ─── walkTree tests ───────────────────────────────────────────────────────────

describe('walkTree', () => {
  test('skips node_modules and .git', () => {
    const root = mkTemp();
    try {
      writeFile(root, 'src/a.js', '');
      writeFile(root, 'node_modules/pkg/index.js', '');
      writeFile(root, '.git/HEAD', '');

      const files = walkTree(root);
      assert.ok(files.includes('src/a.js'));
      assert.ok(!files.some((f) => f.includes('node_modules')));
      assert.ok(!files.some((f) => f.includes('.git')));
    } finally {
      cleanup(root);
    }
  });
});
