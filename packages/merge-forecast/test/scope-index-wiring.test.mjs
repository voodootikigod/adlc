// Rail: every signal uses the scope index it is handed (spec:
// .adlc/specs/merge-forecast-scope-index.md).
//
// A signal that ignored the index and built its own would give the same
// answers, only slower, so no output test can see it. A spy index can: it
// counts the lookups each signal makes through it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { pairKey } from '@adlc/core';

import { createScopeIndex } from '../lib/scope-index.mjs';
import {
  pairScore,
  signalCoChange,
  signalGraphCoupling,
  signalImportRadius,
  signalMigrationCollision,
  signalNamespace,
  signalNamespaceRoutes,
} from '../lib/signals.mjs';

// Two tickets that collide on nothing, so no signal short-circuits another.
const A = { id: 'A', scope: ['src/a/**'] };
const B = { id: 'B', scope: ['src/b/*.mjs'] };
const FILES = {
  'src/a/main.mjs': "import { z } from '../z/other.mjs';\nexport const a = z;\n",
  'src/b/util.mjs': "import { y } from './sibling.mjs';\nexport const b = y;\n",
  'src/z/other.mjs': 'export const z = 1;\n',
};
const REPO_FILES = Object.keys(FILES);
// Present, so the graph and co-change signals read files; matching nothing.
const GRAPH = { fileCoupling: { 'x|y': 1 } };
const CO_CHANGE = { pairCounts: {}, fileCounts: {} };

function spyIndex(files) {
  const real = createScopeIndex(files);
  const calls = { files: 0, filesNormalized: 0, matches: 0, matcher: 0 };
  const spy = {};
  for (const name of Object.keys(calls)) {
    spy[name] = (...args) => {
      calls[name] += 1;
      return real[name](...args);
    };
  }
  return { spy, calls };
}

function withRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), 'mf-wiring-'));
  try {
    for (const [rel, content] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('signals use the scope index they are given', () => {
  test('each file-reading signal looks its files up through the index', () => {
    const cases = [
      ['signalNamespaceRoutes', (i) => signalNamespaceRoutes(A, B, REPO_FILES, i), { files: 2 }],
      ['signalMigrationCollision', (i) => signalMigrationCollision(A, B, REPO_FILES, i), { files: 2 }],
      ['signalNamespace', (i) => signalNamespace(A, B, REPO_FILES, i), { files: 4 }],
      ['signalGraphCoupling', (i) => signalGraphCoupling(A, B, GRAPH, REPO_FILES, i), { files: 2 }],
      ['signalCoChange', (i) => signalCoChange(A, B, CO_CHANGE, REPO_FILES, i), { files: 2 }],
    ];
    for (const [name, run, expected] of cases) {
      const { spy, calls } = spyIndex(REPO_FILES);
      const withSpy = run(spy);
      assert.deepEqual(calls, { files: 0, filesNormalized: 0, matches: 0, matcher: 0, ...expected }, name);
      // ...and it answers what it answers without one.
      assert.deepEqual(withSpy, run(undefined), `${name} without an index`);
    }
  });

  test('import radius reads both directions through the index', () => {
    withRepo((root) => {
      const { spy, calls } = spyIndex(REPO_FILES);
      assert.equal(signalImportRadius(A, B, REPO_FILES, root, spy), 0);
      assert.deepEqual(calls, { files: 0, filesNormalized: 2, matches: 0, matcher: 2 });
      assert.equal(signalImportRadius(A, B, REPO_FILES, root), 0);
    });
  });

  test('a signal that fires gives the same score with the index as without it', () => {
    // With tickets that collide on nothing, "same answer without an index"
    // could not fail: everything is 0 either way. Here each signal fires.
    const fa = 'src/fa.mjs';
    const fb = 'src/fb.mjs';
    const FA = { id: 'FA', scope: [fa] };
    const FB = { id: 'FB', scope: [fb] };
    const routeA = { id: 'RA', scope: ['app/v/[pk]/**'] };
    const routeB = { id: 'RB', scope: ['app/v/[id]/page.tsx'] };
    const migA = { id: 'MA', scope: ['drizzle/0005_a.sql'] };
    const migB = { id: 'MB', scope: ['migrations/0005_b.sql'] };
    const files = [fa, fb, 'app/v/[pk]/page.tsx', 'app/v/[id]/page.tsx', 'drizzle/0005_a.sql', 'migrations/0005_b.sql'];
    const coChange = { pairCounts: { [pairKey(fa, fb)]: 4 }, fileCounts: { [fa]: 4, [fb]: 4 } };
    const cases = [
      ['routes', (i) => signalNamespaceRoutes(routeA, routeB, files, i), true],
      ['migrations', (i) => signalMigrationCollision(migA, migB, files, i), true],
      ['namespace via routes', (i) => signalNamespace(routeA, routeB, files, i), 0.8],
      ['namespace via migrations', (i) => signalNamespace(migA, migB, files, i), 0.8],
      ['co-change', (i) => signalCoChange(FA, FB, coChange, files, i), 0.5],
      ['graph coupling', (i) => signalGraphCoupling(FA, FB, { fileCoupling: { [`${fa}|${fb}`]: 1 } }, files, i), 0.7],
    ];
    for (const [name, run, expected] of cases) {
      const { spy, calls } = spyIndex(files);
      assert.equal(run(spy), expected, `${name} with an index`);
      assert.ok(calls.files > 0, `${name} looked nothing up through the index`);
      assert.equal(run(undefined), expected, `${name} without an index`);
    }
    // pairScore without a scopeIndex builds its own, and it must see the files.
    const firing = { score: 0.8, signal: 'namespace-collision', hardVeto: false };
    assert.deepEqual(pairScore(routeA, routeB, { repoFiles: files }), firing);
    const { spy } = spyIndex(files);
    assert.deepEqual(pairScore(routeA, routeB, { repoFiles: files, scopeIndex: spy }), firing);
  });

  test('graph coupling keeps the direction of a one-sided fileCoupling entry', () => {
    // `a|b` is read first and wins over the undirected pairKey entry; `b|a` is
    // read separately. Swapping which ticket's files are "a" changes the score.
    const fa = 'src/fa.mjs';
    const fb = 'src/fb.mjs';
    const graph = { fileCoupling: { [`${fa}|${fb}`]: 0.1, [pairKey(fa, fb)]: 0.9 } };
    const files = [fa, fb];
    const FA = { id: 'FA', scope: [fa] };
    const FB = { id: 'FB', scope: [fb] };
    assert.equal(signalGraphCoupling(FA, FB, graph, files, createScopeIndex(files)), 0.1 * 0.7);
    assert.equal(signalGraphCoupling(FB, FA, graph, files, createScopeIndex(files)), 0.9 * 0.7);
    // ...and pairScore passes the tickets on in the order it got them.
    const opts = { repoFiles: files, graphCouplingData: graph };
    assert.deepEqual(pairScore(FA, FB, opts), { score: 0.1 * 0.7, signal: 'graph-coupling', hardVeto: false });
    assert.deepEqual(pairScore(FB, FA, opts), { score: 0.9 * 0.7, signal: 'graph-coupling', hardVeto: false });
  });

  test('import radius that fires gives the same score with the index as without it', () => {
    withRepo((root) => {
      const Z = { id: 'Z', scope: ['src/z/*.mjs'] };
      const { spy, calls } = spyIndex(REPO_FILES);
      assert.equal(signalImportRadius(A, Z, REPO_FILES, root, spy), 0.6);
      assert.ok(calls.filesNormalized > 0 && calls.matcher > 0);
      assert.equal(signalImportRadius(A, Z, REPO_FILES, root), 0.6);
      // Pair order reversed: Z's files import nothing, so the score comes from
      // the second direction, A importing into Z.
      assert.equal(signalImportRadius(Z, A, REPO_FILES, root, createScopeIndex(REPO_FILES)), 0.6);
    });
  });

  test('pairScore hands its scopeIndex to every signal', () => {
    withRepo((root) => {
      const { spy, calls } = spyIndex(REPO_FILES);
      const opts = { repoFiles: REPO_FILES, root, coChangeData: CO_CHANGE, graphCouplingData: GRAPH };
      const withSpy = pairScore(A, B, { ...opts, scopeIndex: spy });
      // routes 2 + migrations 2 + graph 2 + co-change 2; import radius 2 + 2.
      assert.deepEqual(calls, { files: 8, filesNormalized: 2, matches: 0, matcher: 2 });
      assert.deepEqual(withSpy, pairScore(A, B, opts));
      assert.deepEqual(withSpy, { score: 0, signal: 'none', hardVeto: false });
    });
  });
});
