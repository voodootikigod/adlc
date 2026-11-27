import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { railDensity, behavioralRailDensity } from '../lib/density.mjs';
import { assignTicket, assignAll } from '../lib/assign.mjs';
import { runRouter } from '../lib/router.mjs';

function makeTmpDir(t, prefix = 'mr-behavioral-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRel(root, relPath, content = '') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

const emptyPriors = { global: {}, byCategory: {} };

describe('railDensity: doc-only rails on code-scoped tickets', () => {
  test('gives 0 numerator credit to README.md, LICENSE, and docs/** when codeScope > 0', () => {
    const ticket = {
      id: 'T-DOC-RAIL',
      title: 'Code change railed only by docs',
      category: 'feature',
      scope: ['src/service.mjs', 'src/handler.mjs'],
      rails: ['README.md', 'LICENSE', 'CHANGELOG.md', 'docs/architecture.md', '.gitignore', 'CODEOWNERS'],
    };
    assert.equal(railDensity(ticket), 0);
  });

  test('retains doc rail credit when all scope patterns are non-code', () => {
    const docOnlyTicket = {
      id: 'T-ALL-DOC',
      title: 'Documentation restructure',
      category: 'feature',
      scope: ['docs/guide.md', 'README.md'],
      rails: ['LICENSE', 'CHANGELOG.md'],
    };
    assert.equal(railDensity(docOnlyTicket), 1);
  });
});

describe('behavioralRailDensity', () => {
  test('discounts doc rails, missing files, zero-assertion files, and tautological assertions', (t) => {
    const root = makeTmpDir(t);
    writeRel(root, 'src/a.mjs', 'export const a = () => 1;\n');
    writeRel(root, 'src/b.mjs', 'export const b = () => 2;\n');
    writeRel(root, 'README.md', 'expect(x).toBe(1)\n');
    writeRel(
      root,
      'test/empty.test.mjs',
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../src/a.mjs';\ntest('smoke only', () => { a(); });\n",
    );
    writeRel(
      root,
      'test/tautology.test.mjs',
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fake', () => { assert(true); assert.ok(true); expect(true).toBe(true); });\n",
    );
    writeRel(
      root,
      'test/py_tautology.py',
      'def test_noop():\n    # assert result == 1\n    assert True\n',
    );

    const zeroTicket = {
      id: 'T-HOLLOW',
      title: 'Hollow rails',
      scope: ['src/a.mjs', 'src/b.mjs'],
      rails: ['README.md', 'test/missing.test.mjs', 'test/empty.test.mjs', 'test/tautology.test.mjs', 'test/py_tautology.py'],
    };
    assert.equal(behavioralRailDensity(zeroTicket, { root }), 0);
    assert.equal(behavioralRailDensity({ id: 'T-NONE', title: 'No rails', scope: ['src/a.mjs'], rails: [] }, { root }), 0);
    assert.equal(behavioralRailDensity({ id: 'T-NOSCOPE', title: 'No scope', scope: [], rails: ['test/empty.test.mjs'] }, { root }), 0);
  });

  test('credits JS, Chai, Python, Go, and Rust real assertions, computes partial density, clamps at 1, and skips .worktrees/node_modules', (t) => {
    const root = makeTmpDir(t);
    writeRel(root, 'src/a.mjs', 'export const a = 1;\n');
    writeRel(root, 'src/b.py', 'x = 2\n');
    writeRel(root, 'src/c.go', 'package main\n');
    writeRel(root, 'src/d.rs', 'pub fn d() -> i32 { 4 }\n');

    writeRel(
      root,
      'test/a.test.mjs',
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('real', () => { assert.equal(1 + 1, 2); });\n",
    );
    writeRel(root, 'test/chai.test.mjs', "test('should', () => { res.should.equal(200); });\n");
    writeRel(root, 'test/empty.test.mjs', 'const x = 1;\n');
    writeRel(root, 'test/test_b.py', 'def test_b():\n    assert compute() == 2\n');
    writeRel(root, 'src/c_test.go', 'package main\nimport "testing"\nfunc TestC(t *testing.T) { t.Fatalf("boom") }\n');
    writeRel(root, 'tests/d_test.rs', '#[test]\nfn works() { assert_eq!(2 + 2, 4); }\n');

    writeRel(root, 'node_modules/pkg/fake.test.mjs', 'expect(x).toBe(1);\n');
    writeRel(root, '.worktrees/w1/test/worktree.test.mjs', 'expect(x).toBe(1);\n');

    const polyTicket = {
      id: 'T-POLY',
      title: 'Polyglot railed ticket',
      scope: ['src/a.mjs', 'src/b.py', 'src/c.go', 'src/d.rs'],
      rails: ['test/a.test.mjs', 'test/test_b.py', 'src/c_test.go', 'tests/d_test.rs'],
    };
    assert.equal(behavioralRailDensity(polyTicket, { root }), 1);

    const partialTicket = {
      id: 'T-PARTIAL',
      title: 'Half railed',
      scope: ['src/a.mjs', 'src/b.py'],
      rails: ['test/chai.test.mjs', 'test/empty.test.mjs'],
    };
    assert.equal(behavioralRailDensity(partialTicket, { root }), 0.5);

    const clampedTicket = {
      id: 'T-CLAMP',
      title: 'Over-railed',
      scope: ['src/a.mjs'],
      rails: ['test/a.test.mjs', 'test/chai.test.mjs'],
    };
    assert.equal(behavioralRailDensity(clampedTicket, { root }), 1);

    const ignoredDirTicket = {
      id: 'T-IGNORED',
      title: 'Ignored dirs do not count',
      scope: ['src/a.mjs'],
      rails: ['**/fake.test.mjs', '**/worktree.test.mjs'],
    };
    assert.equal(behavioralRailDensity(ignoredDirTicket, { root }), 0);
  });
});

describe('assignTicket, assignAll, and runRouter with root option', () => {
  test('routes zero-assertion rails to frontier/P3 finding when root is supplied, preserving syntactic fallback without root', async (t) => {
    const root = makeTmpDir(t);
    writeRel(root, 'src/feature.mjs', 'export function run() { return 42; }\n');
    writeRel(
      root,
      'test/feature.test.mjs',
      "import { test } from 'node:test';\nimport { run } from '../src/feature.mjs';\ntest('no assertions', () => { run(); });\n",
    );
    writeRel(
      root,
      'test/gate.test.mjs',
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('asserted', () => { assert.equal(1, 1); });\n",
    );
    writeRel(root, 'src/gate.mjs', 'export const g = 1;\n');

    const hollowTicket = {
      id: 'T1',
      title: 'Hollow Feature',
      category: 'feature',
      scope: ['src/feature.mjs'],
      rails: ['test/feature.test.mjs'],
      edges: [{ to: 'T2', contract: 'src/gate.mjs' }],
      duration: 1,
    };
    const gateTicket = {
      id: 'T2',
      title: 'Asserted Gate',
      category: 'feature',
      scope: ['src/gate.mjs'],
      rails: ['test/gate.test.mjs'],
      duration: 1,
    };

    const syntactic = assignTicket(hollowTicket, 2, emptyPriors, 0.2);
    assert.equal(syntactic.railDensity, 1);
    assert.equal(syntactic.tier, 'cheap');

    const behavioral = assignTicket(hollowTicket, 2, emptyPriors, 0.2, { root });
    assert.equal(behavioral.railDensity, 0);
    assert.equal(behavioral.tier, 'frontier');
    assert.equal(behavioral.mode, 'direct');

    const batch = assignAll([hollowTicket, gateTicket], { floats: { T1: 2, T2: 0 } }, emptyPriors, 0.2, { root });
    assert.equal(batch[0].railDensity, 0);
    assert.equal(batch[1].railDensity, 1);

    const adlcDir = join(root, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    const ticketsPath = join(adlcDir, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({ tickets: [hollowTicket, gateTicket] }), 'utf8');

    const routerRes = await runRouter({ ticketsPath, floor: 0.2, adlcDir, root });
    assert.equal(routerRes.p3Findings.length, 1);
    assert.equal(routerRes.p3Findings[0].id, 'T1');
  });
});
