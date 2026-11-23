import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createScopeIndex } from '../lib/scope-index.mjs';
import {
  pairScore,
  signalGraphCoupling,
  signalImportRadius,
  signalScopeOverlap,
  walkTree,
} from '../lib/signals.mjs';
import { runForecast } from '../lib/forecast.mjs';

function withTempRepo(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'mf-perf-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('merge-forecast T-P17: walkTree, concrete overlap veto, and O(|F|+|E|) pre-indexing', () => {
  test('walkTree skips .worktrees, .claude, node_modules, and .git', () => {
    withTempRepo(
      {
        'src/app.mjs': 'export const a = 1;\n',
        '.worktrees/feat/src/app.mjs': 'export const a = 2;\n',
        '.claude/settings.json': '{}\n',
        'node_modules/pkg/index.js': 'module.exports = 1;\n',
        '.git/HEAD': 'ref: refs/heads/main\n',
      },
      (root) => {
        const files = walkTree(root);
        assert.deepEqual(files, ['src/app.mjs']);
      },
    );
  });

  test('concrete file intersection triggers hardVeto (never PARALLEL)', async () => {
    const sharedFile = 'src/shared/util.mjs';
    const repoFiles = [sharedFile, 'src/a/one.mjs', 'src/b/two.mjs', 'src/b/three.mjs'];

    // Custom index that reports concrete overlap even when syntactic scopesOverlap is false
    const disjointA = { id: 'A', scope: ['src/only-a/**'] };
    const disjointB = { id: 'B', scope: ['src/only-b/**'] };
    const fakeIndex = {
      files(scope) {
        if (scope === disjointA.scope) return ['src/a/one.mjs', sharedFile];
        if (scope === disjointB.scope) return ['src/b/two.mjs', 'src/b/three.mjs', sharedFile];
        return [];
      },
    };
    assert.equal(signalScopeOverlap(disjointA, disjointB, fakeIndex), 1.0);
    assert.equal(signalScopeOverlap(disjointB, disjointA, fakeIndex), 1.0);

    // Non-overlapping concrete sets return 0 in both length orderings
    const nonOverlapIndex = {
      files(scope) {
        if (scope === disjointA.scope) return ['src/a/one.mjs'];
        if (scope === disjointB.scope) return ['src/b/two.mjs', 'src/b/three.mjs'];
        return [];
      },
    };
    assert.equal(signalScopeOverlap(disjointA, disjointB, nonOverlapIndex), 0);
    assert.equal(signalScopeOverlap(disjointB, disjointA, nonOverlapIndex), 0);

    // End-to-end runForecast with leading wildcard overlapping a concrete path
    await withTempRepo(
      {
        'packages/core/lib/tickets.mjs': 'export const x = 1;\n',
        'packages/cli/lib/cmd.mjs': 'export const y = 2;\n',
      },
      async (root) => {
        const result = await runForecast({
          root,
          tickets: [
            { id: 'T1', title: 'all mjs', scope: ['**/*.mjs'], edges: [] },
            { id: 'T2', title: 'core file', scope: ['packages/core/lib/tickets.mjs'], edges: [] },
          ],
        });
        assert.equal(result.pairs.length, 1);
        assert.equal(result.pairs[0].verdict, 'VETO');
        assert.equal(result.pairs[0].hardVeto, true);
        assert.equal(result.pairs[0].signal, 'scope-overlap');
      },
    );

    // End-to-end runForecast: disjoint multi-level globs (src/*.mjs vs src/**/foo/bar.mjs)
    // must NOT be hard-vetoed.
    await withTempRepo(
      {
        'src/top.mjs': 'export const top = 1;\n',
        'src/deep/foo/bar.mjs': 'export const bar = 2;\n',
      },
      async (root) => {
        const result = await runForecast({
          root,
          tickets: [
            { id: 'T1', title: 'top mjs', scope: ['src/*.mjs'], edges: [] },
            { id: 'T2', title: 'deep bar', scope: ['src/**/foo/bar.mjs'], edges: [] },
          ],
        });
        assert.equal(result.pairs.length, 1);
        assert.equal(result.pairs[0].verdict, 'PARALLEL');
        assert.equal(result.pairs[0].hardVeto, false);
        assert.equal(result.pairs[0].signal, 'none');
      },
    );

    // pairScore returns hardVeto when scopeIndex reports concrete file overlap
    const scored = pairScore(disjointA, disjointB, { repoFiles, scopeIndex: fakeIndex });
    assert.deepEqual(scored, { score: 1.0, signal: 'scope-overlap', hardVeto: true });
  });

  test('importRadiusIntersects caches per (scopeIndex, root) so each file is read once per run', () => {
    withTempRepo(
      {
        'src/a/main.mjs': "import fs from 'node:fs';\nimport { b } from '../b/mod';\nexport const a = [fs, b];\n",
        'src/b/mod.mjs': 'export const b = 1;\n',
        'src/c/other.mjs': 'export const c = 2;\n',
      },
      (root) => {
        const repoFiles = ['src/a/main.mjs', 'src/b/mod.mjs', 'src/c/other.mjs'];
        const index = createScopeIndex(repoFiles);
        const A = { id: 'A', scope: ['src/a/**'] };
        const B = { id: 'B', scope: ['src/b/**'] };
        const C = { id: 'C', scope: ['src/c/**'] };

        // First call reads src/a/main.mjs and caches its resolved import candidates
        assert.equal(signalImportRadius(A, B, repoFiles, root, index), 0.6);
        assert.equal(signalImportRadius(A, C, repoFiles, root, index), 0);

        // Overwrite src/a/main.mjs on disk to remove the import:
        // The same scopeIndex must serve the cached candidates (no re-read).
        writeFileSync(join(root, 'src/a/main.mjs'), 'export const a = 0;\n', 'utf8');
        assert.equal(signalImportRadius(A, B, repoFiles, root, index), 0.6);

        // A fresh scopeIndex must read the updated file from disk.
        const freshIndex = createScopeIndex(repoFiles);
        assert.equal(signalImportRadius(A, B, repoFiles, root, freshIndex), 0);
      },
    );
  });

  test('signalGraphCoupling pre-indexes edges with exact and suffix matching in O(|E|)', () => {
    const repoFiles = [
      'packages/a/src/alpha.mjs',
      'packages/b/src/beta.mjs',
      'packages/c/src/gamma.mjs',
      'packages/d/src/delta.mjs',
    ];
    const index = createScopeIndex(repoFiles);

    const edges = [
      { from: null, to: 'packages/b/src/beta.mjs' }, // missing src ignored
      { from: 'src/alpha.mjs', to: 'packages/b/src/beta.mjs', weight: 0.5 }, // f.endsWith('/' + src)
      { from: 'packages/a/src/alpha.mjs', to: '/abs/repo/packages/b/src/beta.mjs', weight: 0.9 }, // dst.endsWith('/' + f)
      { source: 'packages/c/src/gamma.mjs', target: 'packages/d/src/delta.mjs', weight: 1.5 }, // clamped to 1.0
      { callerFile: 'packages/d/src/delta.mjs', calleeFile: 'packages/a/src/alpha.mjs' }, // default weight 1.0
    ];
    const graph = { edges };

    const A = { id: 'A', scope: ['packages/a/**'] };
    const B = { id: 'B', scope: ['packages/b/**'] };
    const C = { id: 'C', scope: ['packages/c/**'] };
    const D = { id: 'D', scope: ['packages/d/**'] };

    // Higher weight edge (0.9 * 0.7 = 0.63) wins over 0.5 * 0.7 = 0.35 in both orders
    assert.ok(Math.abs(signalGraphCoupling(A, B, graph, repoFiles, index) - 0.63) < 1e-9);
    assert.ok(Math.abs(signalGraphCoupling(B, A, graph, repoFiles, index) - 0.63) < 1e-9);

    // Weight > 1.0 clamped to 1.0 -> 0.7
    assert.ok(Math.abs(signalGraphCoupling(C, D, graph, repoFiles, index) - 0.7) < 1e-9);
    assert.ok(Math.abs(signalGraphCoupling(D, C, graph, repoFiles, index) - 0.7) < 1e-9);

    // Reverse direction (D -> A) with default weight 1.0 -> 0.7
    assert.ok(Math.abs(signalGraphCoupling(A, D, graph, repoFiles, index) - 0.7) < 1e-9);

    // Unconnected pair returns 0
    assert.equal(signalGraphCoupling(B, C, graph, repoFiles, index), 0);

    // Scale test: 30 tickets x 1500 edges completes quickly via O(|E|) pre-index
    const bigFiles = Array.from({ length: 60 }, (_, i) => `pkg${i}/src/f${i}.mjs`);
    const bigIndex = createScopeIndex(bigFiles);
    const bigTickets = Array.from({ length: 30 }, (_, i) => ({
      id: `T${i}`,
      scope: [`pkg${i}/**`],
    }));
    const bigEdges = Array.from({ length: 1500 }, (_, i) => ({
      from: `pkg${i % 60}/src/f${i % 60}.mjs`,
      to: `pkg${(i + 31) % 60}/src/f${(i + 31) % 60}.mjs`,
      weight: 0.8,
    }));
    const bigGraph = { edges: bigEdges };
    const started = performance.now();
    let hits = 0;
    for (let i = 0; i < bigTickets.length; i++) {
      for (let j = i + 1; j < bigTickets.length; j++) {
        if (signalGraphCoupling(bigTickets[i], bigTickets[j], bigGraph, bigFiles, bigIndex) > 0) {
          hits += 1;
        }
      }
    }
    const elapsedMs = performance.now() - started;
    assert.ok(hits > 0, 'expected coupled pairs in scale graph');
    assert.ok(elapsedMs < 1000, `expected pre-indexed graph coupling < 1000ms, got ${elapsedMs.toFixed(1)}ms`);
  });
});
