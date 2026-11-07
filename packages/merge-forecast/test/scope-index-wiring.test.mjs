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
