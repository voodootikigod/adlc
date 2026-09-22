/**
 * Tests for merge-forecast.
 *
 * All tests run offline and use temp directories.
 * Git repos are initialized with synthetic commits for co-change tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmp, gitRepo } from '@adlc/core/test-kit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'merge-forecast.mjs');

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
  signalGraphCoupling,
  walkTree,
  pairScore,
} from '../lib/signals.mjs';

import { pairKey } from '../../core/index.mjs';

import { runForecast } from '../lib/forecast.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mkTicket(id, opts = {}) {
  return { id, title: `Ticket ${id}`, ...opts };
}

function writeFile(root, relPath, content = '') {
  const full = join(root, relPath);
  mkdirSync(join(root, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function gitCommit(dir, files, message) {
  for (const [relPath, content] of Object.entries(files)) {
    writeFile(dir, relPath, content);
    execFileSync('git', ['add', relPath], { cwd: dir, stdio: 'ignore' });
  }
  execFileSync('git', ['commit', '-m', message, '--allow-empty'], { cwd: dir, stdio: 'ignore' });
}

/** Write a tickets file at .adlc/tickets.json under root. */
function writeTickets(root, tickets) {
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2), 'utf8');
}

/**
 * Invoke the merge-forecast bin with cwd=root.
 * Returns { status, stdout, stderr }. Never throws on non-zero exit.
 */
function runBin(root, args = []) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      cwd: root,
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
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
  test('A imports from B scope → 0.6', (t) => {
    const root = tmp(t);
    writeFile(root, 'src/auth/index.js', "import { foo } from '../billing/foo.js';\n");
    writeFile(root, 'src/billing/foo.js', 'export const foo = 1;\n');

    const repoFiles = walkTree(root);
    const a = mkTicket('A', { scope: ['src/auth/**'] });
    const b = mkTicket('B', { scope: ['src/billing/**'] });

    const score = signalImportRadius(a, b, repoFiles, root);
    assert.equal(score, 0.6);
  });

  test('no cross-imports → 0', (t) => {
    const root = tmp(t);
    writeFile(root, 'src/auth/index.js', "import { x } from 'external-pkg';\n");
    writeFile(root, 'src/billing/foo.js', 'export const foo = 1;\n');

    const repoFiles = walkTree(root);
    const a = mkTicket('A', { scope: ['src/auth/**'] });
    const b = mkTicket('B', { scope: ['src/billing/**'] });

    const score = signalImportRadius(a, b, repoFiles, root);
    assert.equal(score, 0);
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

describe('signalGraphCoupling', () => {
  test('fileCoupling map raises score up to 0.7', () => {
    const a = mkTicket('A', { scope: ['src/services/user.ts'] });
    const b = mkTicket('B', { scope: ['src/db/repo.ts'] });
    const repoFiles = ['src/services/user.ts', 'src/db/repo.ts'];
    const graphCouplingData = {
      fileCoupling: {
        'src/services/user.ts|src/db/repo.ts': 1.0,
      },
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.equal(score, 0.7);
  });

  test('edges array connects callers across tickets', () => {
    const a = mkTicket('A', { scope: ['src/services/order.ts'] });
    const b = mkTicket('B', { scope: ['src/payment/gateway.ts'] });
    const repoFiles = ['src/services/order.ts', 'src/payment/gateway.ts'];
    const graphCouplingData = {
      edges: [
        { from: 'src/services/order.ts', to: 'src/payment/gateway.ts', weight: 1.0 },
      ],
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.equal(score, 0.7);
  });

  test('no graph data returns 0', () => {
    const a = mkTicket('A', { scope: ['src/a.ts'] });
    const b = mkTicket('B', { scope: ['src/b.ts'] });
    const score = signalGraphCoupling(a, b, null, ['src/a.ts', 'src/b.ts']);
    assert.equal(score, 0);
  });

  test('sub-1.0 fileCoupling score is not inflated by the loop initial value', () => {
    // maxCoupling must start at 0: if it started at 1, a real coupling score
    // below 1.0 (e.g. 0.5) would never exceed the initial value, so the
    // final score would wrongly stay pinned near the 0.7 cap instead of
    // scaling down with the actual coupling strength.
    const a = mkTicket('A', { scope: ['src/services/user.ts'] });
    const b = mkTicket('B', { scope: ['src/db/repo.ts'] });
    const repoFiles = ['src/services/user.ts', 'src/db/repo.ts'];
    const graphCouplingData = {
      fileCoupling: {
        'src/services/user.ts|src/db/repo.ts': 0.5,
      },
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.equal(score, 0.35);
  });

  test('fileCoupling map with no matching pairs returns 0', () => {
    const a = mkTicket('A', { scope: ['src/a.ts'] });
    const b = mkTicket('B', { scope: ['src/b.ts'] });
    const repoFiles = ['src/a.ts', 'src/b.ts'];
    const graphCouplingData = {
      fileCoupling: {
        'src/other1.ts|src/other2.ts': 0.8,
      },
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.equal(score, 0);
  });

  test('fileCoupling map matches reverse pair key', () => {
    const a = mkTicket('A', { scope: ['src/services/user.ts'] });
    const b = mkTicket('B', { scope: ['src/db/repo.ts'] });
    const repoFiles = ['src/services/user.ts', 'src/db/repo.ts'];
    const graphCouplingData = {
      fileCoupling: {
        'src/db/repo.ts|src/services/user.ts': 0.6,
      },
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.equal(score, 0.42);
  });

  test('a null fileCoupling map is ignored, falling through to the edges array', () => {
    // typeof null === 'object', so the guard must require fileCoupling to be
    // truthy AND an object — not either/or — or a null map would be treated
    // as present and indexing into it would throw instead of falling back.
    const a = mkTicket('A', { scope: ['src/services/order.ts'] });
    const b = mkTicket('B', { scope: ['src/payment/gateway.ts'] });
    const repoFiles = ['src/services/order.ts', 'src/payment/gateway.ts'];
    const graphCouplingData = {
      fileCoupling: null,
      edges: [
        { from: 'src/services/order.ts', to: 'src/payment/gateway.ts', weight: 1.0 },
      ],
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.equal(score, 0.7);
  });

  test('graphCouplingData passed directly as an array of edges', () => {
    const a = mkTicket('A', { scope: ['src/services/order.ts'] });
    const b = mkTicket('B', { scope: ['src/payment/gateway.ts'] });
    const repoFiles = ['src/services/order.ts', 'src/payment/gateway.ts'];
    const graphCouplingData = [
      { from: 'src/services/order.ts', to: 'src/payment/gateway.ts', weight: 0.5 },
    ];
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.equal(score, 0.35);
  });

  test('graphCouplingData with links array format', () => {
    const a = mkTicket('A', { scope: ['src/services/order.ts'] });
    const b = mkTicket('B', { scope: ['src/payment/gateway.ts'] });
    const repoFiles = ['src/services/order.ts', 'src/payment/gateway.ts'];
    const graphCouplingData = {
      links: [
        { source: 'src/services/order.ts', target: 'src/payment/gateway.ts', weight: 0.8 },
      ],
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.ok(Math.abs(score - 0.56) < 1e-6, `expected ~0.56, got ${score}`);
  });

  test('edges array connects reverse direction (B calls A)', () => {
    const a = mkTicket('A', { scope: ['src/services/order.ts'] });
    const b = mkTicket('B', { scope: ['src/payment/gateway.ts'] });
    const repoFiles = ['src/services/order.ts', 'src/payment/gateway.ts'];
    const graphCouplingData = {
      edges: [
        { from: 'src/payment/gateway.ts', to: 'src/services/order.ts', weight: 0.8 },
      ],
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.ok(Math.abs(score - 0.56) < 1e-6, `expected ~0.56, got ${score}`);
  });

  test('edges array touching A but unrelated destination returns 0', () => {
    const a = mkTicket('A', { scope: ['src/services/order.ts'] });
    const b = mkTicket('B', { scope: ['src/payment/gateway.ts'] });
    const repoFiles = ['src/services/order.ts', 'src/payment/gateway.ts'];
    const graphCouplingData = {
      edges: [
        { from: 'src/services/order.ts', to: 'src/unrelated/logger.ts', weight: 1.0 },
      ],
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.equal(score, 0);
  });

  test('edges array touching B but unrelated destination returns 0', () => {
    const a = mkTicket('A', { scope: ['src/services/order.ts'] });
    const b = mkTicket('B', { scope: ['src/payment/gateway.ts'] });
    const repoFiles = ['src/services/order.ts', 'src/payment/gateway.ts'];
    const graphCouplingData = {
      edges: [
        { from: 'src/payment/gateway.ts', to: 'src/unrelated/logger.ts', weight: 1.0 },
      ],
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.equal(score, 0);
  });

  test('incomplete edges missing src or dst are skipped', () => {
    const a = mkTicket('A', { scope: ['src/services/order.ts'] });
    const b = mkTicket('B', { scope: ['src/payment/gateway.ts'] });
    const repoFiles = ['src/services/order.ts', 'src/payment/gateway.ts'];
    const graphCouplingData = {
      edges: [
        { from: 'src/services/order.ts' },
        { to: 'src/payment/gateway.ts' },
        { weight: 1.0 },
        { from: 'src/services/order.ts', to: 'src/payment/gateway.ts', weight: 0.5 },
      ],
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.equal(score, 0.35);
  });

  test('edges with callerFile/calleeFile and fromFile/toFile keys are recognized', () => {
    const a = mkTicket('A', { scope: ['src/a.ts'] });
    const b = mkTicket('B', { scope: ['src/b.ts'] });
    const repoFiles = ['src/a.ts', 'src/b.ts'];
    const graph1 = { edges: [{ callerFile: 'src/a.ts', calleeFile: 'src/b.ts', weight: 1.0 }] };
    assert.equal(signalGraphCoupling(a, b, graph1, repoFiles), 0.7);

    const graph2 = { edges: [{ fromFile: 'src/a.ts', toFile: 'src/b.ts', weight: 1.0 }] };
    assert.equal(signalGraphCoupling(a, b, graph2, repoFiles), 0.7);
  });

  test('edges matching relative path suffixes', () => {
    const a = mkTicket('A', { scope: ['packages/core/src/index.ts'] });
    const b = mkTicket('B', { scope: ['packages/cli/src/main.ts'] });
    const repoFiles = ['packages/core/src/index.ts', 'packages/cli/src/main.ts'];
    const graphCouplingData = {
      edges: [
        { from: 'src/index.ts', to: 'src/main.ts', weight: 1.0 },
      ],
    };
    const score = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
    assert.equal(score, 0.7);
  });

  test('edge weight > 1 is capped to 1.0 and unweighted edge defaults to 1.0', () => {
    const a = mkTicket('A', { scope: ['src/a.ts'] });
    const b = mkTicket('B', { scope: ['src/b.ts'] });
    const repoFiles = ['src/a.ts', 'src/b.ts'];
    const graph1 = { edges: [{ from: 'src/a.ts', to: 'src/b.ts', weight: 5.0 }] };
    assert.equal(signalGraphCoupling(a, b, graph1, repoFiles), 0.7);

    const graph2 = { edges: [{ from: 'src/a.ts', to: 'src/b.ts' }] };
    assert.equal(signalGraphCoupling(a, b, graph2, repoFiles), 0.7);
  });
});

describe('pairScore — dominant signal', () => {
  test('graph coupling dominant signal returned by pairScore', () => {
    const a = mkTicket('A', { scope: ['src/services/user.ts'] });
    const b = mkTicket('B', { scope: ['src/db/repo.ts'] });
    const repoFiles = ['src/services/user.ts', 'src/db/repo.ts'];
    const graphCouplingData = {
      fileCoupling: {
        'src/services/user.ts|src/db/repo.ts': 1.0,
      },
    };
    const { score, signal, hardVeto } = pairScore(a, b, {
      repoFiles,
      root: '/',
      graphCouplingData,
    });
    assert.equal(score, 0.7);
    assert.equal(signal, 'graph-coupling');
    assert.equal(hardVeto, false);
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
  test('single ticket — no pairs, width=1', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/a.js': '// a' }, 'init');

    const tickets = [mkTicket('T1', { scope: ['src/a.js'] })];
    const result = await runForecast({ tickets, root });

    assert.equal(result.pairs.length, 0);
    assert.equal(result.certifiedWidth, 1);
    assert.equal(result.gateFailures.length, 0);
  });

  test('two disjoint tickets — PARALLEL verdict', async (t) => {
    const { dir: root } = gitRepo(t);
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
  });

  test('graph coupling data triggers SEQUENCE verdict on coupled tickets', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/user.ts': '// user' }, 'init user');
    gitCommit(root, { 'src/repo.ts': '// repo' }, 'init repo');

    const tickets = [
      mkTicket('T1', { scope: ['src/user.ts'] }),
      mkTicket('T2', { scope: ['src/repo.ts'] }),
    ];
    const graphCouplingData = {
      edges: [{ from: 'src/user.ts', to: 'src/repo.ts', weight: 1.0 }],
    };
    const result = await runForecast({ tickets, root, graphCouplingData, conflictThreshold: 0.5 });

    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].signal, 'graph-coupling');
    assert.equal(result.pairs[0].score, 0.7);
    assert.equal(result.pairs[0].verdict, 'SEQUENCE');
  });

  test('scope overlap → VETO, concurrent in wave 1 → gateFail', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/auth/index.js': '// auth' }, 'init');

    const tickets = [
      mkTicket('T1', { scope: ['src/auth/**'] }),
      mkTicket('T2', { scope: ['src/auth/**'] }),
    ];
    const result = await runForecast({ tickets, root, conflictThreshold: 0.5 });

    assert.equal(result.pairs[0].verdict, 'VETO');
    assert.ok(result.gateFailures.length > 0);
  });

  test('--width > certifiedWidth → gateFail', async (t) => {
    const { dir: root } = gitRepo(t);
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

    assert.ok(result.gateFailures.some((f) => f.includes('firstWaveWidth')));
  });

  // ─── #997: firstWaveWidth vs scheduleWidth ─────────────────────────────────
  //
  // `certifiedWidth` is computed from wave 1 only. For a foundation-first DAG —
  // the shape ADLC.md D2 recommends — wave 1 holds ONE ticket, so the number is
  // 1 no matter how wide the graph gets later. These tests pin both numbers so
  // the name can no longer do two jobs.

  test('foundation-first DAG: firstWaveWidth is 1 but scheduleWidth is the fan-out', async (t) => {
    const { dir: root } = gitRepo(t);
    // Separate commits so no pair picks up co-change coupling.
    gitCommit(root, { 'src/core/index.js': '// core' }, 'init core');
    gitCommit(root, { 'src/a/index.js': '// a' }, 'init a');
    gitCommit(root, { 'src/b/index.js': '// b' }, 'init b');
    gitCommit(root, { 'src/c/index.js': '// c' }, 'init c');
    gitCommit(root, { 'src/d/index.js': '// d' }, 'init d');
    gitCommit(root, { 'src/final/index.js': '// final' }, 'init final');

    const tickets = [
      mkTicket('T0', {
        scope: ['src/core/**'],
        edges: [{ to: 'T1' }, { to: 'T2' }, { to: 'T3' }, { to: 'T4' }],
      }),
      mkTicket('T1', { scope: ['src/a/**'], edges: [{ to: 'T5' }] }),
      mkTicket('T2', { scope: ['src/b/**'], edges: [{ to: 'T5' }] }),
      mkTicket('T3', { scope: ['src/c/**'], edges: [{ to: 'T5' }] }),
      mkTicket('T4', { scope: ['src/d/**'], edges: [{ to: 'T5' }] }),
      mkTicket('T5', { scope: ['src/final/**'] }),
    ];
    const result = await runForecast({ tickets, root });

    assert.deepEqual(result.waves, [['T0'], ['T1', 'T2', 'T3', 'T4'], ['T5']]);
    assert.equal(result.firstWaveWidth, 1, 'wave 1 holds only the foundation');
    assert.equal(result.scheduleWidth, 4, 'the fan-out wave supports four builders');
  });

  test('certifiedWidth is an exact alias of firstWaveWidth', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/core/index.js': '// core' }, 'init core');
    gitCommit(root, { 'src/a/index.js': '// a' }, 'init a');
    gitCommit(root, { 'src/b/index.js': '// b' }, 'init b');

    const tickets = [
      mkTicket('T0', { scope: ['src/core/**'], edges: [{ to: 'T1' }, { to: 'T2' }] }),
      mkTicket('T1', { scope: ['src/a/**'] }),
      mkTicket('T2', { scope: ['src/b/**'] }),
    ];
    const result = await runForecast({ tickets, root });

    // The alias is the compatibility contract for existing consumers, and it
    // must track the WAVE-1 number — not the new schedule-wide one — or every
    // caller reading it silently changes meaning.
    assert.equal(result.certifiedWidth, result.firstWaveWidth);
    assert.equal(result.certifiedWidth, 1);
    assert.equal(result.scheduleWidth, 2);
  });

  test('flat DAG: firstWaveWidth equals scheduleWidth', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/a/index.js': '// a' }, 'init a');
    gitCommit(root, { 'src/b/index.js': '// b' }, 'init b');
    gitCommit(root, { 'src/c/index.js': '// c' }, 'init c');

    const tickets = [
      mkTicket('T1', { scope: ['src/a/**'] }),
      mkTicket('T2', { scope: ['src/b/**'] }),
      mkTicket('T3', { scope: ['src/c/**'] }),
    ];
    const result = await runForecast({ tickets, root });

    assert.equal(result.waves.length, 1);
    assert.equal(result.firstWaveWidth, 3);
    assert.equal(result.scheduleWidth, 3);
  });

  test('conflicting pair inside a later wave lowers scheduleWidth below the wave size', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/core/index.js': '// core' }, 'init core');
    gitCommit(root, { 'src/a/index.js': '// a' }, 'init a');
    gitCommit(root, { 'src/b/index.js': '// b' }, 'init b');
    gitCommit(root, { 'src/shared/index.js': '// shared' }, 'init shared');

    // T3 and T4 both claim src/shared/** — a hard veto — so the four-ticket
    // wave can only dispatch three at once.
    const tickets = [
      mkTicket('T0', {
        scope: ['src/core/**'],
        edges: [{ to: 'T1' }, { to: 'T2' }, { to: 'T3' }, { to: 'T4' }],
      }),
      mkTicket('T1', { scope: ['src/a/**'] }),
      mkTicket('T2', { scope: ['src/b/**'] }),
      mkTicket('T3', { scope: ['src/shared/**'] }),
      mkTicket('T4', { scope: ['src/shared/**'] }),
    ];
    const result = await runForecast({ tickets, root, conflictThreshold: 0.5 });

    assert.equal(result.waves[1].length, 4, 'four tickets are topologically ready');
    assert.equal(result.scheduleWidth, 3, 'but the vetoed pair cannot both run');
  });

  test('--width gate boundary is unchanged and still measured against wave 1', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/core/index.js': '// core' }, 'init core');
    gitCommit(root, { 'src/a/index.js': '// a' }, 'init a');
    gitCommit(root, { 'src/b/index.js': '// b' }, 'init b');

    const tickets = [
      mkTicket('T0', { scope: ['src/core/**'], edges: [{ to: 'T1' }, { to: 'T2' }] }),
      mkTicket('T1', { scope: ['src/a/**'] }),
      mkTicket('T2', { scope: ['src/b/**'] }),
    ];

    // firstWaveWidth is 1; scheduleWidth is 2. The gate must still compare
    // against the WAVE-1 number, so width=1 passes and width=2 fails even
    // though the schedule could eventually support 2.
    const atBoundary = await runForecast({ tickets, root, width: 1 });
    assert.deepEqual(atBoundary.gateFailures, []);

    const overBoundary = await runForecast({ tickets, root, width: 2 });
    assert.equal(overBoundary.gateFailures.length, 1);
  });

  test('the --width failure message names wave 1 and reports scheduleWidth', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/core/index.js': '// core' }, 'init core');
    gitCommit(root, { 'src/a/index.js': '// a' }, 'init a');
    gitCommit(root, { 'src/b/index.js': '// b' }, 'init b');

    const tickets = [
      mkTicket('T0', { scope: ['src/core/**'], edges: [{ to: 'T1' }, { to: 'T2' }] }),
      mkTicket('T1', { scope: ['src/a/**'] }),
      mkTicket('T2', { scope: ['src/b/**'] }),
    ];
    const result = await runForecast({ tickets, root, width: 3 });

    const msg = result.gateFailures.find((f) => f.includes('--width 3'));
    assert.ok(msg, 'the width gate failed');
    // The operator must learn WHY a foundation-first DAG rejects a wide
    // request, which means the message has to say it is a wave-1 number and
    // show what the schedule itself could support.
    assert.match(msg, /firstWaveWidth 1/);
    assert.match(msg, /wave 1/i);
    assert.match(msg, /scheduleWidth 2/);
  });

  test('dependency-cycle early return still carries both width fields', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/a.js': '// a' }, 'init a');

    const tickets = [
      mkTicket('T1', { scope: ['src/a/**'], edges: [{ to: 'T2' }] }),
      mkTicket('T2', { scope: ['src/b/**'], edges: [{ to: 'T1' }] }),
    ];
    const result = await runForecast({ tickets, root });

    assert.ok(result.gateFailures.some((f) => f.includes('dependency cycle')));
    // A consumer reading the new fields on the failure path must not see
    // `undefined` — it would render as "Schedule width: undefined".
    assert.equal(result.firstWaveWidth, 0);
    assert.equal(result.scheduleWidth, 0);
    assert.equal(result.certifiedWidth, 0);
  });

  test('an empty ticket list reports zero for both widths', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/a.js': '// a' }, 'init');

    const result = await runForecast({ tickets: [], root });

    // scheduleWidth folds over the waves, so its seed is only observable
    // when there are NO waves to fold. Without this case a non-zero seed
    // reports a schedule that can absorb builders it does not have.
    assert.deepEqual(result.waves, []);
    assert.equal(result.scheduleWidth, 0);
    assert.equal(result.firstWaveWidth, 0);
    assert.equal(result.certifiedWidth, 0);
    assert.equal(result.recommendedWidth, 0);
  });

  test('backpressure width computed correctly', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/a.js': '// a' }, 'init');

    const tickets = [mkTicket('T1', { scope: ['src/a.js'] })];
    const result = await runForecast({
      tickets,
      root,
      buildMin: 20,
      mergeMin: 4,
    });

    assert.equal(result.backpressureWidth, 5); // round(20/4) = 5
  });

  test('namespace collision → 0.8 score', async (t) => {
    const { dir: root } = gitRepo(t);
    mkdirSync(join(root, 'app/votes/[pk]'), { recursive: true });
    mkdirSync(join(root, 'app/votes/[voteKey]'), { recursive: true });
    writeFileSync(join(root, 'app/votes/[pk]/page.tsx'), '// pk page');
    writeFileSync(join(root, 'app/votes/[voteKey]/details.tsx'), '// voteKey details');
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
  });

  test('co-change integration: correlated files raise score', async (t) => {
    const { dir: root } = gitRepo(t);
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
  });

  test('DAG edges — downstream ticket in wave 2', async (t) => {
    const { dir: root } = gitRepo(t);
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
  });

  test('degrades gracefully when not a git repo (co-change skipped)', async (t) => {
    const root = tmp(t);
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
  });

  test('migration prefix collision detected', async (t) => {
    const { dir: root } = gitRepo(t);
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
  });
});

// ─── walkTree tests ───────────────────────────────────────────────────────────

describe('walkTree', () => {
  test('skips node_modules and .git', (t) => {
    const root = tmp(t);
    writeFile(root, 'src/a.js', '');
    writeFile(root, 'node_modules/pkg/index.js', '');
    writeFile(root, '.git/HEAD', '');

    const files = walkTree(root);
    assert.ok(files.includes('src/a.js'));
    assert.ok(!files.some((f) => f.includes('node_modules')));
    assert.ok(!files.some((f) => f.includes('.git')));
  });
});

// ─── Cyclic DAG regression (Spec D2 — must validate the ticket DAG) ────────────
//
// Regression for: a cyclic ticket DAG (T1→T2→T3→T1) was silently drained by the
// indegree-0 wave scheduler, producing waves:[], mergeOrder:[], gateFailures:[]
// and EXIT 0 — a genuine dependency-cycle partition reported as a clean schedule
// of zero tickets. A cycle must fail the gate (exit 2) and name the tickets.

describe('cyclic ticket DAG', () => {
  test('runForecast surfaces a cycle as a gate failure naming the tickets', async (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/a.js': '// a' }, 'init');

    const tickets = [
      mkTicket('T1', { scope: ['src/a.js'], edges: [{ to: 'T2', contract: '' }] }),
      mkTicket('T2', { scope: ['src/b.js'], edges: [{ to: 'T3', contract: '' }] }),
      mkTicket('T3', { scope: ['src/c.js'], edges: [{ to: 'T1', contract: '' }] }),
    ];
    const result = await runForecast({ tickets, root });

    assert.equal(result.gateFailures.length, 1);
    assert.match(result.gateFailures[0], /cycle/i);
    for (const id of ['T1', 'T2', 'T3']) {
      assert.ok(
        result.gateFailures[0].includes(id),
        `expected cycle message to name ${id}, got: ${result.gateFailures[0]}`
      );
    }
    // Must NOT pretend to have a valid (empty) schedule.
    assert.deepEqual(result.waves, []);
    assert.deepEqual(result.mergeOrder, []);
  });

  test('bin exits 2 with a cycle error mentioning the involved ticket ids', (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/a.js': '// a' }, 'init');
    writeTickets(root, [
      mkTicket('T1', { scope: ['src/a.js'], edges: [{ to: 'T2', contract: '' }] }),
      mkTicket('T2', { scope: ['src/b.js'], edges: [{ to: 'T3', contract: '' }] }),
      mkTicket('T3', { scope: ['src/c.js'], edges: [{ to: 'T1', contract: '' }] }),
    ]);

    const { status, stdout, stderr } = runBin(root);
    const out = stdout + stderr;

    assert.equal(status, 2, `expected exit 2 (gate fail), got ${status}\n${out}`);
    assert.match(out, /cycle/i);
    for (const id of ['T1', 'T2', 'T3']) {
      assert.ok(out.includes(id), `expected output to name ${id}, got:\n${out}`);
    }
  });

  test('bin exits 2 for a cyclic DAG under --json too (no clean exit 0)', (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/a.js': '// a' }, 'init');
    writeTickets(root, [
      mkTicket('T1', { scope: ['src/a.js'], edges: [{ to: 'T2', contract: '' }] }),
      mkTicket('T2', { scope: ['src/b.js'], edges: [{ to: 'T1', contract: '' }] }),
    ]);

    const { status, stdout } = runBin(root, ['--json']);
    assert.equal(status, 2, `expected exit 2, got ${status}\n${stdout}`);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.gateFailures.length > 0);
    assert.match(parsed.gateFailures[0], /cycle/i);
    assert.ok(parsed.gateFailures[0].includes('T1') && parsed.gateFailures[0].includes('T2'));
  });

  test('valid acyclic DAG still exits 0 (no regression)', (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/auth/index.js': '// a', 'src/billing/index.js': '// b' }, 'init');
    writeTickets(root, [
      mkTicket('T1', { scope: ['src/auth/**'], edges: [{ to: 'T2', contract: 'src/auth/index.js' }] }),
      mkTicket('T2', { scope: ['src/billing/**'] }),
    ]);

    const { status, stdout, stderr } = runBin(root);
    assert.equal(status, 0, `expected exit 0 for acyclic DAG, got ${status}\n${stdout}${stderr}`);
  });

  test('completed tickets are excluded from merge-forecast bin schedule and do not gate dependent tickets', (t) => {
    const { dir: root } = gitRepo(t);
    gitCommit(root, { 'src/auth/index.js': '// a' }, 'init');
    writeTickets(root, [
      mkTicket('T1', { completed: true, scope: ['src/auth/**'], edges: [{ to: 'T2' }] }),
      mkTicket('T2', { scope: ['src/auth/**'] }),
    ]);

    const { status, stdout, stderr } = runBin(root, ['--json']);
    assert.equal(status, 0, `expected exit 0, got ${status}\n${stdout}${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.waves.length, 1);
    assert.deepEqual(parsed.waves[0], ['T2']);
  });
});
