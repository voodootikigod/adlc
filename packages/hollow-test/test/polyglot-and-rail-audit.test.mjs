// Unit and CLI tests for polyglot hollow-test, P3 anti-mock rail audit,
// structural call-site mutation wiring, and configured test mapping.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepo, tmp } from '@adlc/core/test-kit';
import {
  polyglotLanguage,
  isPolyglotTestFile,
  generatePolyglotMutants,
  checkPolyglotSyntax,
} from '../lib/polyglot.mjs';
import { auditRailAdequacy } from '../lib/rail-audit.mjs';
import { isSupportedSourceExtension, isMutableSource, filterTargetFiles } from '../lib/targets.mjs';
import { resolveConfiguredTestTarget, testTargetFor, classify, mutantBudget } from '../lib/gate-plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '../bin/hollow-test.mjs');

function hasBinary(name) {
  const r = spawnSync('which', [name], { encoding: 'utf8', stdio: 'pipe' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const PYTHON_BIN = hasBinary('python3');
const GOFMT_BIN = hasBinary('gofmt');
const RUSTFMT_BIN = hasBinary('rustfmt');

function findPycachePaths(dir) {
  const hits = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) {
      hits.push(full);
    } else if (entry.isDirectory()) {
      hits.push(...findPycachePaths(full));
    }
  }
  return hits;
}

function makeCommitRepo(t, { base = {}, change = {} } = {}) {
  const repo = gitRepo(t, { prefix: 'hollow-poly-' });
  const put = (rel, text) => {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    writeFileSync(join(repo.dir, rel), text, 'utf8');
  };
  for (const [rel, text] of Object.entries(base)) put(rel, text);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'base');
  const baseSha = repo.git('rev-parse', 'HEAD').trim();
  for (const [rel, text] of Object.entries(change)) put(rel, text);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'change');
  return { ...repo, base: baseSha, put };
}

function runHollow(cwd, args, env = process.env) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60_000,
    env,
  });
}

function makeRustfmtShim(t) {
  const binDir = tmp(t, 'rustfmt-shim-');
  const shimPath = join(binDir, 'rustfmt');
  const script = [
    '#!/usr/bin/env node',
    "import { readFileSync } from 'node:fs';",
    'const lastArg = process.argv[process.argv.length - 1];',
    'const src = lastArg && lastArg.endsWith(".rs") ? readFileSync(lastArg, "utf8") : readFileSync(0, "utf8");',
    'if (src.includes("SYNTAX_ERR") || (src.match(/\\{/g)?.length ?? 0) !== (src.match(/\\}/g)?.length ?? 0)) {',
    '  process.stderr.write("error: unexpected token\\n");',
    '  process.exit(1);',
    '}',
    'process.stdout.write(src);',
    'process.exit(0);',
    '',
  ].join('\n');
  writeFileSync(shimPath, script, 'utf8');
  chmodSync(shimPath, 0o755);
  return binDir;
}

describe('polyglot language & target classification', () => {
  it('identifies python, go, and rust extensions case-insensitively', () => {
    assert.equal(polyglotLanguage('src/app.py'), 'python');
    assert.equal(polyglotLanguage('src/APP.PY'), 'python');
    assert.equal(polyglotLanguage('pkg/main.go'), 'go');
    assert.equal(polyglotLanguage('pkg/MAIN.GO'), 'go');
    assert.equal(polyglotLanguage('src/lib.rs'), 'rust');
    assert.equal(polyglotLanguage('src/LIB.RS'), 'rust');
    assert.equal(polyglotLanguage('src/index.mjs'), null);
    assert.equal(polyglotLanguage('Makefile'), null);
    assert.equal(polyglotLanguage(null), null);
  });

  it('classifies polyglot test files accurately', () => {
    for (const testFile of [
      'test_auth.py',
      'pkg/test_auth.py',
      'auth_test.py',
      'pkg/auth_test.py',
      'conftest.py',
      'pkg/conftest.py',
      'handler_test.go',
      'pkg/handler_test.go',
      'tests/api.rs',
      'tests/sub/integration.rs',
      'crates/core/tests/e2e.rs',
    ]) {
      assert.equal(isPolyglotTestFile(testFile), true, testFile);
    }
    for (const srcFile of [
      'src/app.py',
      'src/contest.py',
      'pkg/handler.go',
      'pkg/testutil.go',
      'src/lib.rs',
      'src/tests_helper.rs',
    ]) {
      assert.equal(isPolyglotTestFile(srcFile), false, srcFile);
    }
    assert.equal(isPolyglotTestFile(null), false);
  });

  it('keeps default JS/TS source predicates unchanged and gates .py/.go/.rs behind polyglot:true', () => {
    for (const f of ['src/app.py', 'pkg/main.go', 'src/lib.rs']) {
      assert.equal(isSupportedSourceExtension(f), false, `${f} default ext`);
      assert.equal(isMutableSource(f), false, `${f} default mutable`);
      assert.equal(isSupportedSourceExtension(f, { polyglot: true }), true, `${f} polyglot ext`);
      assert.equal(isMutableSource(f, { polyglot: true }), true, `${f} polyglot mutable`);
    }
    assert.equal(isSupportedSourceExtension('types.d.ts', { polyglot: true }), false);
    assert.equal(isMutableSource('types.d.ts', { polyglot: true }), false);

    for (const tf of ['test_app.py', 'app_test.py', 'conftest.py', 'pkg/foo_test.go', 'tests/it.rs']) {
      assert.equal(isMutableSource(tf, { polyglot: true }), false, `${tf} excluded as test`);
    }
    assert.equal(
      isMutableSource('pkg/test_runner.py', { polyglot: true, sourceGlobs: ['**/test_runner.py'] }),
      true,
    );

    const changed = {
      'src/app.py': new Set([1]),
      'src/test_app.py': new Set([1]),
      'pkg/srv.go': new Set([2]),
      'pkg/srv_test.go': new Set([2]),
      'src/lib.rs': new Set([3]),
      'tests/api.rs': new Set([3]),
    };
    assert.deepEqual(filterTargetFiles(changed), []);
    assert.deepEqual(filterTargetFiles(changed, { polyglot: true }), ['src/app.py', 'pkg/srv.go', 'src/lib.rs']);
  });
});

describe('generatePolyglotMutants', () => {
  it('generates Python mutants while masking strings, docstrings, and # comments', () => {
    const py = [
      '# x == 1 and True is None',
      '"""',
      'Docstring with True == False and x is None',
      '"""',
      'def check(x, flag):',
      '    label = "x == 1 and True"',
      '    if x == 1 and flag is None:  # True != False',
      '        return True',
      '    if x != 2 or flag is not None:',
      '        return x + 1',
      '    return "hello"',
      '    return  None',
      '    return (None)',
      '    return',
    ].join('\n');

    const mutants = generatePolyglotMutants(py, 'python');
    assert.ok(mutants.every((m) => m.line >= 7 && m.line <= 11));
    assert.ok(mutants.some((m) => m.line === 7 && m.mutated.includes('x != 1') && m.mutated.endsWith('# True != False')));
    assert.ok(mutants.some((m) => m.line === 7 && m.mutated.includes('flag is not None')));
    assert.ok(mutants.some((m) => m.line === 7 && m.mutated.includes(' or flag')));
    assert.ok(mutants.some((m) => m.line === 8 && m.mutated.trim() === 'return False'));
    assert.ok(mutants.some((m) => m.line === 8 && m.mutated.trim() === 'return None'));
    assert.ok(mutants.some((m) => m.line === 9 && m.mutated.includes('x == 2')));
    assert.ok(mutants.some((m) => m.line === 9 && m.mutated.includes('flag is None')));
    assert.ok(mutants.some((m) => m.line === 9 && m.mutated.includes(' and flag')));
    assert.ok(mutants.some((m) => m.line === 10 && m.mutated.trim() === 'return None'));
    assert.ok(mutants.some((m) => m.line === 11 && m.mutated.trim() === 'return None'));
    assert.equal(mutants.some((m) => m.line >= 12), false);

    assert.deepEqual(
      generatePolyglotMutants('def f():\n    return "hello"\n', 'python').map((m) => m.mutated),
      ['    return None'],
    );
    assert.deepEqual(generatePolyglotMutants('def f():\n    return  None\n', 'python'), []);

    const scoped = generatePolyglotMutants(py, 'python', { targetLines: [8], maxMutants: 1 });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].line, 8);
    assert.deepEqual(generatePolyglotMutants(py, 'unknown'), []);
    assert.deepEqual(generatePolyglotMutants(py, 'python', { maxMutants: 0 }), []);
  });

  it('generates Go and Rust mutants while skipping //, block comments, strings, raw strings, and Rust lifetimes', () => {
    const goSrc = [
      '// a == b && true',
      '/* multi',
      '   a <= b || false */',
      'const msg = `a == b && true`',
      'func ok(a int, b int, f bool) bool {',
      '  if a <= b && f == true { // c != d',
      '    return a >= 0 || false',
      '  }',
      '  return false',
      '}',
    ].join('\n');
    const goMutants = generatePolyglotMutants(goSrc, 'go');
    assert.ok(goMutants.every((m) => m.line >= 6));
    assert.ok(goMutants.some((m) => m.line === 6 && m.mutated.includes('a > b')));
    assert.ok(goMutants.some((m) => m.line === 6 && m.mutated.includes('|| f == true')));
    assert.ok(goMutants.some((m) => m.line === 7 && m.mutated.includes('a < 0')));
    assert.ok(goMutants.some((m) => m.line === 7 && m.mutated.includes('&& false')));
    assert.ok(goMutants.some((m) => m.line === 9 && m.mutated.includes('return true')));

    const rustSrc = [
      '// opt.is_some() && true',
      'pub fn present<\'a>(opt: &\'a Option<&\'a str>, ready: bool) -> bool {',
      '    let ch = \'=\';',
      '    opt.is_some() && !opt.is_none() || ready != false',
      '}',
    ].join('\n');
    const rustMutants = generatePolyglotMutants(rustSrc, 'rust');
    assert.ok(rustMutants.every((m) => m.line === 4));
    assert.ok(rustMutants.some((m) => m.mutated.includes('opt.is_none() && !opt.is_none()')));
    assert.ok(rustMutants.some((m) => m.mutated.includes('|| !opt.is_none()')));
    assert.ok(rustMutants.some((m) => m.mutated.includes('ready == false')));
    assert.ok(rustMutants.some((m) => m.mutated.includes('ready != true')));
  });
});

describe('checkPolyglotSyntax & CLI --polyglot / --structural', () => {
  it('checks Python syntax on a temp file leaving zero __pycache__ and reports ENOENT as unknown', { skip: !PYTHON_BIN && 'python3 unavailable' }, (t) => {
    const dir = tmp(t, 'py-syntax-');
    const target = join(dir, 'mod.py');
    writeFileSync(target, 'def add(a, b):\n    return a + b\n', 'utf8');

    const valid = checkPolyglotSyntax(target, 'def add(a, b):\n    return a + b\n', 'python');
    assert.equal(valid.verdict, 'valid');
    assert.equal(valid.detail, null);

    const invalid = checkPolyglotSyntax(target, 'def add(a, b:\n    return a + b\n', 'python');
    assert.equal(invalid.verdict, 'invalid');
    assert.ok(typeof invalid.detail === 'string' && invalid.detail.length > 0);
    assert.deepEqual(findPycachePaths(dir), []);

    const emptyBin = tmp(t, 'empty-path-');
    const missing = checkPolyglotSyntax(target, 'x = 1\n', 'python', { env: { ...process.env, PATH: emptyBin } });
    assert.equal(missing.verdict, 'unknown');
    assert.match(missing.detail, /python3/);
  });

  it('checks Go and Rust syntax and reports missing toolchains as unknown', (t) => {
    const emptyBin = tmp(t, 'empty-go-rs-');
    assert.equal(checkPolyglotSyntax('x.go', 'package p\n', 'go', { env: { ...process.env, PATH: emptyBin } }).verdict, 'unknown');
    assert.equal(checkPolyglotSyntax('x.rs', 'pub fn f() {}\n', 'rust', { env: { ...process.env, PATH: emptyBin } }).verdict, 'unknown');
    assert.equal(checkPolyglotSyntax('x.txt', 'hello\n', undefined).verdict, 'unknown');

    if (GOFMT_BIN) {
      assert.equal(checkPolyglotSyntax('a.go', 'package main\nfunc F() bool { return true }\n', 'go').verdict, 'valid');
      assert.equal(checkPolyglotSyntax('a.go', 'package main\nfunc F( {\n', 'go').verdict, 'invalid');
    }

    const shimDir = RUSTFMT_BIN ? dirname(RUSTFMT_BIN) : makeRustfmtShim(t);
    const rustEnv = { ...process.env, PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}` };
    const crateDir = tmp(t, 'rust-crate-');
    mkdirSync(join(crateDir, 'src'), { recursive: true });
    writeFileSync(join(crateDir, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n', 'utf8');
    assert.equal(
      checkPolyglotSyntax(join(crateDir, 'src/lib.rs'), 'mod submod;\npub async fn ok() -> bool { true }\n', 'rust', { env: rustEnv }).verdict,
      'valid',
    );
    assert.equal(checkPolyglotSyntax('lib.rs', 'pub fn broken() -> bool { \n', 'rust', { env: rustEnv }).verdict, 'invalid');
  });

  it('runs hollow-test --polyglot on Python: kills valid mutants, discards invalid mutants without false kills, fails closed on missing toolchains, and leaves zero __pycache__', { skip: !PYTHON_BIN && 'python3 unavailable' }, (t) => {
    const basePy = 'def gate(x):\n    return False\n';
    const changedPy = [
      'def gate(x):',
      '    return (',
      '        x == 4',
      '    )',
      '',
    ].join('\n');
    const testPy = [
      'import unittest',
      'from app import gate',
      'class GateTest(unittest.TestCase):',
      '    def test_gate(self):',
      '        self.assertTrue(gate(4))',
      '        self.assertFalse(gate(5))',
      'if __name__ == "__main__":',
      '    unittest.main()',
      '',
    ].join('\n');

    const repo = makeCommitRepo(t, {
      base: { 'app.py': basePy, 'test_app.py': testPy },
      change: { 'app.py': changedPy },
    });

    // Line 2 `return (` mutates to `return None`, leaving lines 3-4 orphaned (SyntaxError -> invalid).
    // With --max 1, invalid must NOT spend quota or count as a false kill; line 3 `x == 4` -> `x != 4` runs and is killed.
    const passRun = runHollow(repo.dir, [
      '--polyglot',
      '--base', repo.base,
      '--test-cmd', 'python3 -m unittest test_app.py',
      '--max', '1',
      '--json',
    ]);
    assert.equal(passRun.status, 0, passRun.stderr + passRun.stdout);
    const report = JSON.parse(passRun.stdout);
    assert.ok(report.summary.invalid >= 1, 'multiline return None mutant discarded as invalid');
    assert.equal(report.summary.killed, 1, 'valid comparison mutant ran and was killed');
    assert.equal(report.summary.survived, 0);
    assert.deepEqual(findPycachePaths(repo.dir), [], 'zero __pycache__ left in repository');

    // Surviving Python mutant exits 2
    const weakRun = runHollow(repo.dir, [
      '--polyglot',
      '--base', repo.base,
      '--test-cmd', 'python3 -c "import app"',
      '--max', '1',
      '--json',
    ]);
    assert.equal(weakRun.status, 2, weakRun.stderr + weakRun.stdout);
    assert.equal(JSON.parse(weakRun.stdout).summary.survived, 1);
    assert.deepEqual(findPycachePaths(repo.dir), []);

    // Missing toolchain fails closed (exit 1) before mutating
    const toolBin = tmp(t, 'no-py-bin-');
    for (const needed of ['git', 'sh']) {
      const resolved = hasBinary(needed);
      if (resolved) symlinkSync(resolved, join(toolBin, needed));
    }
    symlinkSync(process.execPath, join(toolBin, 'node'));
    const noPyRun = runHollow(
      repo.dir,
      ['--polyglot', '--base', repo.base, '--test-cmd', 'node --version', '--max', '1'],
      { ...process.env, PATH: toolBin },
    );
    assert.equal(noPyRun.status, 1);
    assert.match(noPyRun.stderr, /python3/);
    assert.equal(readFileSync(join(repo.dir, 'app.py'), 'utf8'), changedPy);
  });

  it('runs hollow-test --polyglot on Go and Rust repositories', (t) => {
    const shimDir = RUSTFMT_BIN ? dirname(RUSTFMT_BIN) : makeRustfmtShim(t);
    const envWithRust = { ...process.env, PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}` };

    const rustRepo = makeCommitRepo(t, {
      base: {
        'src/lib.rs': 'pub fn has_val(x: Option<i32>) -> bool {\n    false\n}\n',
        'check_rs.mjs': [
          "import { readFileSync } from 'node:fs';",
          "const s = readFileSync('src/lib.rs', 'utf8');",
          'process.exit(s.includes("x.is_some()") ? 0 : 1);',
          '',
        ].join('\n'),
      },
      change: {
        'src/lib.rs': 'pub fn has_val(x: Option<i32>) -> bool {\n    x.is_some()\n}\n',
      },
    });

    const rsRun = runHollow(
      rustRepo.dir,
      ['--polyglot', '--base', rustRepo.base, '--test-cmd', 'node check_rs.mjs', '--max', '1', '--json'],
      envWithRust,
    );
    assert.equal(rsRun.status, 0, rsRun.stderr + rsRun.stdout);
    assert.equal(JSON.parse(rsRun.stdout).summary.killed, 1);

    if (GOFMT_BIN) {
      const goRepo = makeCommitRepo(t, {
        base: {
          'pkg/calc.go': 'package pkg\nfunc Ready(v int) bool {\n\treturn false\n}\n',
          'check_go.mjs': [
            "import { readFileSync } from 'node:fs';",
            "const s = readFileSync('pkg/calc.go', 'utf8');",
            'process.exit(s.includes("v >= 10") ? 0 : 1);',
            '',
          ].join('\n'),
        },
        change: {
          'pkg/calc.go': 'package pkg\nfunc Ready(v int) bool {\n\treturn v >= 10\n}\n',
        },
      });
      const goRun = runHollow(goRepo.dir, [
        '--polyglot', '--base', goRepo.base, '--test-cmd', 'node check_go.mjs', '--max', '1', '--json',
      ]);
      assert.equal(goRun.status, 0, goRun.stderr + goRun.stdout);
      assert.equal(JSON.parse(goRun.stdout).summary.killed, 1);
    }
  });

  it('threads --structural into mutate.generateMutants for call-site option-drop mutations', (t) => {
    const baseJs = 'export function invoke(run, opts) {\n  run(opts);\n}\n';
    const changedJs = 'export function invoke(run) {\n  run({ encoding: "utf8", dryRun: mode });\n}\n';
    const testJs = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "test('passes dryRun option', () => {",
      "  const src = readFileSync('src/invoke.mjs', 'utf8');",
      "  assert.ok(src.includes('dryRun: mode'));",
      '});',
      '',
    ].join('\n');

    const repo = makeCommitRepo(t, {
      base: { 'src/invoke.mjs': baseJs, 'Mode.mjs': 'export const mode = "check";\n', 'test/invoke.test.mjs': testJs },
      change: { 'src/invoke.mjs': 'import { mode } from "../Mode.mjs";\n' + changedJs },
    });

    const withoutStructural = runHollow(repo.dir, [
      '--base', repo.base, '--test-cmd', 'node --test test/invoke.test.mjs', '--max', '1',
    ]);
    assert.equal(withoutStructural.status, 1);

    const withStructural = runHollow(repo.dir, [
      '--structural', '--base', repo.base, '--test-cmd', 'node --test test/invoke.test.mjs', '--max', '1', '--json',
    ]);
    assert.equal(withStructural.status, 0, withStructural.stderr + withStructural.stdout);
    const parsed = JSON.parse(withStructural.stdout);
    assert.equal(parsed.summary.killed, 1);
    assert.equal(parsed.mutants[0].operator, 'object-arg-key-drop');
  });
});

describe('auditRailAdequacy & CLI --audit-rails', () => {
  it('rejects empty, missing, and root-escaping rail paths', (t) => {
    const dir = tmp(t, 'rail-audit-bounds-');
    const outside = tmp(t, 'rail-audit-outside-');
    writeFileSync(join(outside, 'secret.test.mjs'), 'assert.equal(1, 1);\n', 'utf8');
    symlinkSync(join(outside, 'secret.test.mjs'), join(dir, 'escape-link.test.mjs'));
    mkdirSync(join(dir, 'subdir'));

    assert.throws(() => auditRailAdequacy([], { root: dir }), /at least one/);
    assert.throws(() => auditRailAdequacy(['missing.test.mjs'], { root: dir }), /not found/);
    assert.throws(() => auditRailAdequacy(['../outside.test.mjs'], { root: dir }), /escapes repository root/);
    assert.throws(() => auditRailAdequacy([join(outside, 'secret.test.mjs')], { root: dir }), /escapes repository root/);
    assert.throws(() => auditRailAdequacy(['escape-link.test.mjs'], { root: dir }), /escapes repository root/);
    assert.throws(() => auditRailAdequacy(['subdir'], { root: dir }), /not a regular file/);
  });

  it('flags missing-assertions, tautological-only, and mock-only-internal, and passes backed behavioral tests', (t) => {
    const dir = tmp(t, 'rail-audit-cases-');
    mkdirSync(join(dir, 'test'), { recursive: true });
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib/service.mjs'), 'export const calc = (n) => n * 2;\n', 'utf8');

    writeFileSync(
      join(dir, 'test/no-assert.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nconst { assert: cjsAssert } = require('node:assert');\nconst { assert } = require('node:assert');\n// assert.equal(1, 2);\nconst decoy = 'assert.equal(1, 2)';\ntest('noop', () => { const x = 1 + 1; return x; });\n",
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/regex-with-quotes.test.mjs'),
      "import assert from 'node:assert/strict';\nconst ERR = /couldn't parse/;\nconst PAT = /[/*]/;\nassert.equal(ERR.test(\"couldn't parse\"), true);\nassert.equal(PAT.test('/'), true);\n",
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/regex-mock-smuggle.test.mjs'),
      "const a = /\"/;\nvi.mock('../lib/unbacked.mjs');\nconst b = /\"/;\nexpect(1 + 1).toBe(2);\n",
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/raw_go_valid_test.go'),
      'package p\nimport "testing"\nfunc TestRaw(t *testing.T) {\n\ts := `odd " quote`\n\tif s == "" { t.Fatalf("unexpected") }\n}\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/raw_go_decoy_test.go'),
      'package p\nimport "testing"\nfunc TestDecoy(t *testing.T) {\n\t_ = `t.Errorf("decoy")`\n}\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/raw_rust_decoy.rs'),
      '#[test]\nfn decoy() {\n    let _s = r#"assert_eq!(1, 2)"#;\n}\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/taut-js.test.mjs'),
      "import assert from 'node:assert/strict';\nassert.ok(true);\nassert(true);\nexpect(true).toBe(true);\n",
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/taut-py.py'),
      '# assert x == 1\ndef test_trivial():\n    assert True\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/mock-unit.test.mjs'),
      "import { expect, vi } from 'vitest';\nvi.mock('../lib/service.mjs');\nexpect(1 + 2).toBe(3);\n",
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/mock-module.test.mjs'),
      "import assert from 'node:assert/strict';\nmock.module('../lib/service.js', () => ({}));\nassert.equal(2 + 2, 4);\n",
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/real-integration.test.mjs'),
      "import assert from 'node:assert/strict';\nimport { calc } from '../lib/service.ts';\nassert.equal(calc(3), 6);\n",
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/external-mock.test.mjs'),
      "import { expect, jest } from '@jest/globals';\njest.mock('axios');\nexpect(calcVal()).toBe(true);\n",
      'utf8',
    );

    const badNoAssert = auditRailAdequacy(['test/no-assert.test.mjs'], { root: dir });
    assert.equal(badNoAssert.ok, false);
    assert.equal(badNoAssert.violations[0].reason, 'missing-assertions');

    const badTaut = auditRailAdequacy(['test/taut-js.test.mjs', 'test/taut-py.py'], { root: dir });
    assert.equal(badTaut.ok, false);
    assert.equal(badTaut.audited, 2);
    assert.deepEqual(badTaut.violations.map((v) => v.reason), ['tautological-only', 'tautological-only']);

    // Python unittest.TestCase assertions (self.assertEqual / self.assertTrue)
    writeFileSync(
      join(dir, 'test/unittest_valid.py'),
      'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(gate(4))\n        self.assertEqual(gate(5), False)\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'test/unittest_taut.py'),
      'import unittest\nclass T(unittest.TestCase):\n    def test_taut(self):\n        self.assertTrue(True)\n        self.assertEqual(1, 1)\n',
      'utf8',
    );
    assert.equal(auditRailAdequacy(['test/unittest_valid.py'], { root: dir }).ok, true);
    const utTaut = auditRailAdequacy(['test/unittest_taut.py'], { root: dir });
    assert.equal(utTaut.ok, false);
    assert.equal(utTaut.violations[0].reason, 'tautological-only');

    // Mock-only without unmocked importer fails; two files that BOTH mock the same stem also fail
    const badMockSingle = auditRailAdequacy(['test/mock-unit.test.mjs'], { root: dir });
    assert.equal(badMockSingle.ok, false);
    assert.equal(badMockSingle.violations[0].reason, 'mock-only-internal');

    const badBothMock = auditRailAdequacy(['test/mock-unit.test.mjs', 'test/mock-module.test.mjs'], { root: dir });
    assert.equal(badBothMock.ok, false);
    assert.equal(badBothMock.violations.length, 2);

    // Backed by real-integration.test.mjs importing the same stem without mocking -> passes!
    const backed = auditRailAdequacy(
      [
        'test/mock-unit.test.mjs',
        'test/real-integration.test.mjs',
        'test/external-mock.test.mjs',
        'test/regex-with-quotes.test.mjs',
        'test/raw_go_valid_test.go',
      ],
      { root: dir },
    );
    assert.equal(backed.ok, true);
    assert.equal(backed.audited, 5);
    assert.deepEqual(backed.violations, []);

    const regexSmuggle = auditRailAdequacy(['test/regex-mock-smuggle.test.mjs'], { root: dir });
    assert.equal(regexSmuggle.ok, false);
    assert.equal(regexSmuggle.violations[0].reason, 'mock-only-internal');

    writeFileSync(
      join(dir, 'test/emoji-offset.test.mjs'),
      "// 🚀🎉 astral comment\nconst EMOJI = /🚀🎉/u;\nvi.mock('../lib/unbacked.mjs');\nexpect(EMOJI.test('🚀🎉')).toBe(true);\n",
      'utf8',
    );
    const emojiOffset = auditRailAdequacy(['test/emoji-offset.test.mjs'], { root: dir });
    assert.equal(emojiOffset.ok, false);
    assert.equal(emojiOffset.violations[0].reason, 'mock-only-internal');

    const rawDecoys = auditRailAdequacy(['test/raw_go_decoy_test.go', 'test/raw_rust_decoy.rs'], { root: dir });
    assert.equal(rawDecoys.ok, false);
    assert.deepEqual(rawDecoys.violations.map((v) => v.reason), ['missing-assertions', 'missing-assertions']);
  });

  it('runs standalone via hollow-test --audit-rails without --test-cmd and exits 0, 1, or 2 appropriately', (t) => {
    const dir = tmp(t, 'rail-audit-cli-');
    writeFileSync(join(dir, 'zero.test.mjs'), "import { test } from 'node:test';\ntest('empty', () => {});\n", 'utf8');
    writeFileSync(
      join(dir, 'good.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds', () => { assert.equal(2 + 3, 5); });\n",
      'utf8',
    );

    const failJson = runHollow(dir, ['--audit-rails', 'zero.test.mjs', '--json']);
    assert.equal(failJson.status, 2, failJson.stderr + failJson.stdout);
    const failReport = JSON.parse(failJson.stdout);
    assert.equal(failReport.ok, false);
    assert.equal(failReport.violations[0].reason, 'missing-assertions');

    const failText = runHollow(dir, ['--audit-rails', 'zero.test.mjs']);
    assert.equal(failText.status, 2);
    assert.match(failText.stdout, /missing-assertions/);

    const passJson = runHollow(dir, ['--audit-rails', 'good.test.mjs', '--json']);
    assert.equal(passJson.status, 0, passJson.stderr + passJson.stdout);
    assert.equal(JSON.parse(passJson.stdout).ok, true);

    const passText = runHollow(dir, ['--audit-rails', 'good.test.mjs']);
    assert.equal(passText.status, 0);
    assert.match(passText.stdout, /passed adequacy audit/);

    const errMissing = runHollow(dir, ['--audit-rails', 'nope.test.mjs']);
    assert.equal(errMissing.status, 1);
    assert.match(errMissing.stderr, /not found/);

    const errEscape = runHollow(dir, ['--audit-rails', '../escape.test.mjs']);
    assert.equal(errEscape.status, 1);
    assert.match(errEscape.stderr, /escapes repository root/);
  });
});

describe('resolveConfiguredTestTarget in gate-plan.mjs', () => {
  it('resolves configured hollowTest.testMap ahead of built-in heuristics and rejects unsafe targets', (t) => {
    const root = tmp(t, 'gate-plan-cfg-');
    const outsideDir = tmp(t, 'gate-plan-outside-');
    mkdirSync(join(root, '.adlc'), { recursive: true });
    mkdirSync(join(root, 'packages/foo/test'), { recursive: true });
    symlinkSync(outsideDir, join(root, 'symlink-dir'), 'dir');

    assert.equal(resolveConfiguredTestTarget('packages/foo/lib/x.mjs', root), null);

    writeFileSync(
      join(root, '.adlc/config.json'),
      JSON.stringify({
        hollowTest: {
          testMap: {
            'packages/foo/**': 'custom-suite/foo.test.mjs',
            'services/billing/**': 'tests/billing.test.mjs',
          },
        },
      }),
      'utf8',
    );

    assert.equal(resolveConfiguredTestTarget('packages/foo/lib/x.mjs', root), 'custom-suite/foo.test.mjs');
    assert.equal(testTargetFor('packages/foo/lib/x.mjs', root), 'custom-suite/foo.test.mjs');
    assert.equal(testTargetFor('services/billing/charge.mjs', root), 'tests/billing.test.mjs');

    const decision = classify(['services/billing/charge.mjs'], 10, root);
    assert.equal(decision.kind, 'fast');
    assert.equal(decision.testCmd, 'node --test tests/billing.test.mjs');

    const unsafeTargets = [
      '../outside.test.mjs',
      'tests/../outside.test.mjs',
      '/abs/path.test.mjs',
      '"/abs/outside.test.mjs"',
      '"--import=/tmp/evil.mjs"',
      "'--import=/tmp/evil.mjs'",
      '\\-\\-import=/tmp/evil.mjs',
      '~/outside.test.mjs',
      'tests/a.test.mjs #',
      'symlink-dir/*.test.mjs',
      '-e "process.exit(0)"',
      'tests/a.test.mjs; echo bad',
      'tests/a.test.mjs & echo bad',
      'tests/a.test.mjs | cat',
      'tests/$HOME.test.mjs',
      'tests/`id`.test.mjs',
      'tests/a<b.test.mjs',
      'tests/a>b.test.mjs',
      'tests/(sub).test.mjs',
      'tests/line\nbreak.test.mjs',
      'tests/cr\rbreak.test.mjs',
    ];

    for (const unsafe of unsafeTargets) {
      writeFileSync(
        join(root, '.adlc/config.json'),
        JSON.stringify({ hollowTest: { testMap: { 'services/**': unsafe } } }),
        'utf8',
      );
      assert.equal(
        resolveConfiguredTestTarget('services/billing/charge.mjs', root),
        null,
        `must reject unsafe target: ${JSON.stringify(unsafe)}`,
      );
    }

    const multiTargetDecision = {
      kind: 'fast',
      max: 12,
      files: Array.from({ length: 47 }, (_, i) => `packages/p${i % 14}/lib/f${i}.mjs`),
      testCmd: Array.from({ length: 14 }, (_, i) => `node --test packages/p${i}/test/*.test.mjs`).join(' && '),
    };
    const multiBudget = mutantBudget(multiTargetDecision, { runMs: 126_000, windowMs: 45 * 60_000 });
    assert.equal(multiBudget.ok, true);
    assert.equal(multiBudget.want, 94);
    assert.equal(multiBudget.draw, 94, 'per-file --file-test-map amortizes runMs across distinct && targets');
    assert.equal(multiBudget.capped, false);
  });
});
