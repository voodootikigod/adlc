// hollow-test/test/comment-only-diff.test.mjs
// Issue #1032: #658 fails closed when a diff-derived file produces zero
// mutants. That is right for a real code change the operators cannot see, and
// wrong for a diff that changes only COMMENTS — there is no behaviour to
// mutate, and the tool already has a "not covered" bucket for exactly that.
//
// The danger this file guards is the opposite direction. targets.mjs warns in
// its own comments: "A coverage gate that reports green by not looking is
// worse than no gate." Every ambiguity must resolve to "this is code".

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { changedLinesAreCommentOnly } from '../lib/targets.mjs';

const BIN = resolve(new URL('.', import.meta.url).pathname, '../bin/hollow-test.mjs');

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
function commitAll(dir, msg = 'c') {
  git(['add', '-A'], dir);
  git(['commit', '-m', msg], dir);
}
function runCli(args, cwd) {
  return spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
}

const lines = (...xs) => xs.join('\n');

// ── the predicate, in isolation ────────────────────────────────────────────

describe('changedLinesAreCommentOnly', () => {
  it('a plain line comment is a comment', () => {
    const src = lines('const a = 1;', '// just a note', 'export { a };');
    assert.equal(changedLinesAreCommentOnly(src, [2]), true);
  });

  it('a blank line counts as not-code', () => {
    const src = lines('const a = 1;', '', '   ', 'export { a };');
    assert.equal(changedLinesAreCommentOnly(src, [2, 3]), true);
  });

  it('a line inside a multi-line block comment is a comment', () => {
    const src = lines('/*', ' * explanation', ' * more', ' */', 'const a = 1;');
    assert.equal(changedLinesAreCommentOnly(src, [2, 3]), true);
  });

  it('code with a trailing comment is CODE', () => {
    const src = lines('const a = 1; // trailing');
    assert.equal(changedLinesAreCommentOnly(src, [1]), false);
  });

  it('a closed block-comment prefix followed by code is CODE', () => {
    // packages/core/lib/mutate.mjs documents this exact shape as #372 defect 4.
    const src = lines('/* closed */ const limit = 3;');
    assert.equal(changedLinesAreCommentOnly(src, [1]), false);
  });

  it('THE TRAP: a comment-looking line inside a multi-line template is CODE', () => {
    // A naive per-line `^\s*//` scan calls line 3 a comment and skips a real
    // change to string CONTENT. Template literals are the only string that
    // crosses a line boundary, which is why they need real state.
    const src = lines(
      'export const banner = `',
      'hello',
      '// this is data, not a comment',
      '`;'
    );
    assert.equal(changedLinesAreCommentOnly(src, [3]), false);
  });

  it('a backtick inside a line comment does not open a template', () => {
    const src = lines(
      '// use `backticks` in prose',
      '// and more prose',
      'const a = 1;'
    );
    assert.equal(changedLinesAreCommentOnly(src, [1, 2]), true);
  });

  it('a backtick inside a quoted string does not open a template', () => {
    const src = lines(
      'const tick = "`";',
      '// a real comment',
      'const b = 2;'
    );
    assert.equal(changedLinesAreCommentOnly(src, [2]), true);
  });

  it('a backtick inside a REGEX character class does not open a template', () => {
    // Found in packages/context-handoff/lib/adapter.mjs. Without regex
    // handling the backtick in the class opened a template, a later backtick
    // in prose closed it, and the `/*` inside `` `.adlc/*` `` then opened a
    // SPURIOUS BLOCK COMMENT — after which real code read as comment text.
    const src = lines(
      'const re =',
      '  /(?:adlc\\s+)?(?:[^\\s;|&`\'"()]*[/\\\\])?handoff/gi;',
      '// paths are gitignored (`.adlc/*`), so nothing appears in a diff.',
      'export function run() { return re; }'
    );
    assert.equal(changedLinesAreCommentOnly(src, [3]), true,
      'the prose line is a comment');
    assert.equal(changedLinesAreCommentOnly(src, [4]), false,
      'the code line after it must NOT be swallowed by a spurious block comment');
  });

  it('a division sign is not mistaken for a regex', () => {
    const src = lines('const half = total / 2;', '// note');
    assert.equal(changedLinesAreCommentOnly(src, [1]), false);
    assert.equal(changedLinesAreCommentOnly(src, [2]), true);
  });

  it('the two passes must AGREE — a comment-shaped line inside a template is code', () => {
    // Pass 2 alone calls line 3 a comment; pass 1 knows it is template data.
    // Disagreement resolves to code, which is the whole safety property.
    const src = lines('const t = `', 'a', '// data', '`;', 'const after = 1;');
    assert.equal(changedLinesAreCommentOnly(src, [3]), false);
  });

  it('fails closed on an unterminated block comment', () => {
    const src = lines('const a = 1;', '/* never closed', '// looks like a comment');
    assert.equal(changedLinesAreCommentOnly(src, [3]), false);
  });

  it('fails closed on an unterminated template literal', () => {
    const src = lines('const a = `never closed', '// looks like a comment');
    assert.equal(changedLinesAreCommentOnly(src, [2]), false);
  });

  it('fails closed on a line number outside the file', () => {
    assert.equal(changedLinesAreCommentOnly(lines('// a'), [99]), false);
  });

  it('an import line is CODE, not a comment (that cause stays failing closed)', () => {
    const src = lines("import { x } from './x.mjs';", '// note');
    assert.equal(changedLinesAreCommentOnly(src, [1]), false);
  });

  it('a mixed set with one code line is CODE', () => {
    const src = lines('// note', 'const a = 1;');
    assert.equal(changedLinesAreCommentOnly(src, [1, 2]), false);
  });

  it('an empty changed-line set is not treated as comment-only', () => {
    // Nothing changed means this predicate has no opinion; the caller must not
    // read "true" as permission to skip.
    assert.equal(changedLinesAreCommentOnly(lines('// a'), []), false);
  });
});

// ── end to end through the CLI ─────────────────────────────────────────────

describe('CLI: a comment-only diff is reported as not covered, not a failure', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-commentonly-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'math.mjs'), lines(
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      ''
    ));
    writeFileSync(join(dir, 'test', 'math.test.mjs'), lines(
      "import { describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.mjs';",
      "describe('add', () => {",
      "  it('sums', () => { assert.strictEqual(add(2, 3), 5); });",
      '});',
      ''
    ));
    commitAll(dir, 'init');

    // Second commit adds ONLY a comment.
    writeFileSync(join(dir, 'src', 'math.mjs'), lines(
      '// Adds two numbers. Explanatory only.',
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      ''
    ));
    commitAll(dir, 'comment only');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('exits 0 and names the file it did not cover', () => {
    const r = runCli(['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1'], dir);
    assert.equal(r.status, 0,
      `expected exit 0 for a comment-only diff\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const out = r.stdout + r.stderr;
    assert.match(out, /math\.mjs/, 'the uncovered file must be named — a green gate is never silent');
    assert.match(out, /comment/i, 'the reason must be stated');
  });
});

describe('CLI: a template-literal change is NOT mistaken for a comment', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-tmpl-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'banner.mjs'), lines(
      'export const banner = `',
      'line one',
      '`;',
      ''
    ));
    writeFileSync(join(dir, 'test', 'banner.test.mjs'), lines(
      "import { describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { banner } from '../src/banner.mjs';",
      "describe('banner', () => { it('exists', () => { assert.ok(banner); }); });",
      ''
    ));
    commitAll(dir, 'init');

    // The changed line LOOKS like a comment but is template content.
    writeFileSync(join(dir, 'src', 'banner.mjs'), lines(
      'export const banner = `',
      'line one',
      '// not a comment — this is data',
      '`;',
      ''
    ));
    commitAll(dir, 'template content');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('does not silently skip the file — it still fails closed', () => {
    const r = runCli(['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1'], dir);
    const out = r.stdout + r.stderr;
    // Assert on the SKIP REPORT, not on the word "comment": #658's own refusal
    // message contains "comment-only, blank, or a shape none of the mutation
    // operators recognize", so matching that word would pass for either
    // behaviour — the exact hollow assertion this suite is about.
    assert.doesNotMatch(out, /touched only comment or blank lines/,
      `template content must never be reported as a comment-only skip\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.status, 1,
      `a real template-content change must still fail closed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  });
});
