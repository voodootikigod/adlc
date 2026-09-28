// hollow-test/test/comment-only-deletions.test.mjs
// A file is skipped as "comment-only" only when the change leaves its PROGRAM
// untouched. Judging the added lines alone is not enough: a hunk that deletes a
// code line and adds a comment in its place, or wraps live code in `/* */`,
// adds nothing but comment text and still changes behaviour. Every such shape
// must stay eligible so the zero-mutant refusal fires instead of a green gate.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { changedLinesAreCommentOnly, fileChangeIsCommentOnly } from '../lib/targets.mjs';
import { deletedLinesFromDiff } from '../lib/diff-deletions.mjs';

// Every fixture the factories below mint; removed once this file's tests finish.
const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

const BIN = resolve(new URL('.', import.meta.url).pathname, '../bin/hollow-test.mjs');
const lines = (...xs) => xs.join('\n');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepo(dir) {
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['config', 'gpg.format', 'openpgp'], dir);
}
function commitAll(dir, msg) {
  git(['add', '-A'], dir);
  git(['commit', '-m', msg], dir);
}
function runCli(args, cwd) {
  return spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
}

const GUARD_SRC = lines(
  'export function allowed(user) {',
  '  if (!user.isAdmin) return false;',
  '  return true;',
  '}',
  ''
);
// The suite never exercises the non-admin path, so the baseline stays green
// once the guard is gone — exactly the case where only the gate can object.
const GUARD_TEST = lines(
  "import { it } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { allowed } from '../src/auth.mjs';",
  "it('admits an admin', () => { assert.strictEqual(allowed({ isAdmin: true }), true); });",
  ''
);

/** A repo whose second commit rewrites src/auth.mjs to `after`. */
function fixture(prefix, before, after) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtureDirs.add(dir);
  initRepo(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src', 'auth.mjs'), before);
  writeFileSync(join(dir, 'test', 'auth.test.mjs'), GUARD_TEST);
  commitAll(dir, 'init');
  writeFileSync(join(dir, 'src', 'auth.mjs'), after);
  commitAll(dir, 'change');
  return dir;
}

const TEST_CMD = 'node --test test/auth.test.mjs';

function assertRefused(r) {
  assert.equal(r.status, 1,
    `a behaviour-changing diff must not pass as comment-only\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /no changed behaviour/);
  assert.match(r.stderr, /zero mutants/);
}

describe('CLI: code removed and replaced by comment text is NOT comment-only', () => {
  const dirs = [];
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it('a guard line replaced by a comment fails closed', () => {
    const dir = fixture('hollow-del-comment-', GUARD_SRC, GUARD_SRC.replace(
      '  if (!user.isAdmin) return false;', '  // admin check removed'));
    dirs.push(dir);
    assertRefused(runCli(['--test-cmd', TEST_CMD, '--base', 'HEAD~1'], dir));
  });

  it('a guard line replaced by a blank line fails closed', () => {
    const dir = fixture('hollow-del-blank-', GUARD_SRC, GUARD_SRC.replace(
      '  if (!user.isAdmin) return false;', ''));
    dirs.push(dir);
    assertRefused(runCli(['--test-cmd', TEST_CMD, '--base', 'HEAD~1'], dir));
  });

  it('live code wrapped in an added block comment fails closed', () => {
    const dir = fixture('hollow-del-wrap-', GUARD_SRC, GUARD_SRC.replace(
      '  if (!user.isAdmin) return false;', '  /*\n  if (!user.isAdmin) return false;\n  */'));
    dirs.push(dir);
    assertRefused(runCli(['--test-cmd', TEST_CMD, '--base', 'HEAD~1'], dir));
  });

  it('deleting the closing `*/` of a block comment fails closed', () => {
    const before = lines(
      'export function allowed(user) {',
      '  /* note',
      '  */',
      '  if (!user.isAdmin) return false;',
      '  return true;',
      '  /* end */',
      '}',
      ''
    );
    const dir = fixture('hollow-del-close-', before, before.replace('  */\n', ''));
    dirs.push(dir);
    const r = runCli(['--test-cmd', TEST_CMD, '--base', 'HEAD~1'], dir);
    assert.notEqual(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /no changed behaviour/);
  });
});

describe('CLI: a change that truly touches only comments still passes', () => {
  const dirs = [];
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it('a reworded comment is comment-only', () => {
    const before = lines('// old wording', GUARD_SRC);
    const dir = fixture('hollow-reword-', before, lines('// new wording', GUARD_SRC));
    dirs.push(dir);
    const r = runCli(['--test-cmd', TEST_CMD, '--base', 'HEAD~1'], dir);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /src\/auth\.mjs/);
  });

  it('a deleted comment is comment-only', () => {
    const dir = fixture('hollow-delcomment-', lines('// stale note', GUARD_SRC), GUARD_SRC);
    dirs.push(dir);
    const r = runCli(['--test-cmd', TEST_CMD, '--base', 'HEAD~1'], dir);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /src\/auth\.mjs/);
  });
});

describe('CLI --json: a comment-only skip is reported, never an empty green', () => {
  let dir;
  before(() => { dir = fixture('hollow-json-skip-', GUARD_SRC, lines('// a note', GUARD_SRC)); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('prints a JSON report naming the skipped file', () => {
    const r = runCli(['--test-cmd', TEST_CMD, '--base', 'HEAD~1', '--json'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.notEqual(r.stdout.trim(), '', 'a JSON consumer must get a report, not empty stdout');
    const report = JSON.parse(r.stdout);
    assert.equal(report.tool, 'hollow-test');
    assert.deepEqual(report.skipped, { commentOnly: ['src/auth.mjs'] });
    assert.equal(report.summary.total, 0);
  });
});

describe('fileChangeIsCommentOnly', () => {
  const base = lines('const a = 1;', 'export { a };');

  it('is false when nothing was added or deleted', () => {
    assert.equal(fileChangeIsCommentOnly({ oldSource: base, newSource: base, added: [], deleted: [] }), false);
  });

  it('is false when the old source is unavailable', () => {
    const next = lines('// n', base);
    assert.equal(fileChangeIsCommentOnly({ oldSource: null, newSource: next, added: [1], deleted: [] }), false);
  });

  it('is false when a deleted line was code, even if every added line is a comment', () => {
    const next = lines('// gone', 'export { a };');
    assert.equal(fileChangeIsCommentOnly({ oldSource: base, newSource: next, added: [1], deleted: [1] }), false);
  });

  it('is false when a deleted line number is outside the old source', () => {
    const next = lines('// n', base);
    assert.equal(fileChangeIsCommentOnly({ oldSource: base, newSource: next, added: [1], deleted: [9] }), false);
  });

  it('is false when the added lines are comments but the program changed around them', () => {
    const next = lines('/*', 'const a = 1;', '*/', 'export { a };');
    assert.equal(fileChangeIsCommentOnly({ oldSource: base, newSource: next, added: [1, 3], deleted: [] }), false);
  });

  it('is true for a reworded comment', () => {
    const old = lines('// before', base);
    const next = lines('// after', base);
    assert.equal(fileChangeIsCommentOnly({ oldSource: old, newSource: next, added: [1], deleted: [1] }), true);
  });

  it('is true for a pure comment deletion', () => {
    const old = lines('// stale', base);
    assert.equal(fileChangeIsCommentOnly({ oldSource: old, newSource: base, added: [], deleted: [1] }), true);
  });

  it('is true for a new file holding only comments', () => {
    assert.equal(fileChangeIsCommentOnly({ oldSource: '', newSource: '// hi\n', added: [1], deleted: [] }), true);
  });

  it('treats a changed string as code even when every changed line is comment-shaped', () => {
    const old = lines('const s = `', '// a', '`;');
    const next = lines('const s = `', '// b', '`;');
    assert.equal(fileChangeIsCommentOnly({ oldSource: old, newSource: next, added: [2], deleted: [2] }), false);
  });
});

describe('deletedLinesFromDiff', () => {
  it('records old-side line numbers and the old path of every changed file', () => {
    const diff = lines(
      'diff --git a/src/x.mjs b/src/y.mjs',
      '--- a/src/x.mjs',
      '+++ b/src/y.mjs',
      '@@ -1,4 +1,3 @@',
      ' keep',
      '-gone one',
      '-gone two',
      '+added',
      ' keep',
      '@@ -10,2 +9,1 @@',
      ' ctx',
      '-late',
      ''
    );
    const out = deletedLinesFromDiff(diff);
    assert.deepEqual(Object.keys(out), ['src/y.mjs']);
    assert.equal(out['src/y.mjs'].oldPath, 'src/x.mjs');
    assert.deepEqual([...out['src/y.mjs'].lines], [2, 3, 11]);
  });

  it('reads a deleted line that itself begins with `--` as a deletion, not a header', () => {
    const diff = lines(
      '--- a/a.mjs',
      '+++ b/a.mjs',
      '@@ -1,2 +1,1 @@',
      '---counter;',
      ' keep',
      ''
    );
    assert.deepEqual([...deletedLinesFromDiff(diff)['a.mjs'].lines], [1]);
  });

  it('records a new file with no old path', () => {
    const diff = lines('--- /dev/null', '+++ b/n.mjs', '@@ -0,0 +1 @@', '+x', '');
    const out = deletedLinesFromDiff(diff);
    assert.equal(out['n.mjs'].oldPath, null);
    assert.equal(out['n.mjs'].lines.size, 0);
  });

  it('skips a "\\ No newline" marker without advancing', () => {
    const diff = lines(
      '--- a/a.mjs',
      '+++ b/a.mjs',
      '@@ -1,2 +1,2 @@',
      '-one',
      '\\ No newline at end of file',
      '-two',
      '+both',
      '+three',
      ''
    );
    assert.deepEqual([...deletedLinesFromDiff(diff)['a.mjs'].lines], [1, 2]);
  });
});

describe('scanner: a regex after a keyword is a regex', () => {
  it('two keyword-led regexes holding a backtick do not invert a template', () => {
    const src = lines(
      'function a(t) { return /`/.test(t); }',
      'export const banner = `',
      'hello',
      '// data line',
      '`;',
      'function b(t) { return /`/.test(t); }',
      ''
    );
    assert.equal(changedLinesAreCommentOnly(src, [4]), false);
  });

  for (const kw of ['typeof', 'case', 'throw', 'in', 'of', 'delete', 'void', 'yield', 'await', 'else', 'do', 'new', 'instanceof']) {
    it(`treats \`/\` after \`${kw}\` as a regex`, () => {
      const src = lines(
        `x = ${kw} /\`/;`,
        'const s = `',
        '// data',
        '`;',
        `y = ${kw} /\`/;`,
        ''
      );
      assert.equal(changedLinesAreCommentOnly(src, [3]), false);
    });
  }

  it('still treats `/` after an ordinary identifier as division', () => {
    const src = lines('const q = total / count; // ratio', '// note', 'const r = q / 2;', '');
    assert.equal(changedLinesAreCommentOnly(src, [2]), true);
  });

  it('an identifier that merely ends in a keyword is not that keyword', () => {
    const src = lines('const q = result / 2;', '// note', 'const r = subreturn / 2;', '');
    assert.equal(changedLinesAreCommentOnly(src, [2]), true);
  });
});

describe('CLI: a failing baseline with large output still prints its reason', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-flush-'));
    initRepo(dir);
    writeFileSync(join(dir, 'loud.mjs'),
      "process.stdout.write('o'.repeat(300000) + '\\n');\n" +
      "process.stderr.write('e'.repeat(300000) + '\\n');\n" +
      'process.exit(3);\n');
    writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
    commitAll(dir, 'init');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('the reason line reaches a piped stderr', () => {
    // A shell pipe, not spawnSync's own capture: spawnSync drains so fast that
    // the pipe never fills, which hides an exit that outruns a pending write.
    const cmd = `node "${BIN}" --test-cmd "node loud.mjs" --base HEAD 2>&1 >/dev/null | cat`;
    for (let i = 0; i < 3; i++) {
      const r = spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', timeout: 60000 });
      assert.match(r.stdout, /error: baseline suite is not green \(exit 3\)/);
      assert.match(r.stdout, /truncated/, 'the diagnostic blocks are still written');
    }
  });
});
