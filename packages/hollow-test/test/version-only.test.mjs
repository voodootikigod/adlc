// hollow-test/test/version-only.test.mjs
// A lockstep release bump rewrites generated files whose only change is a
// version literal ('1.11.1' -> '1.12.0'). No operator can exercise that, so
// #658's zero-mutant refusal failed every release. Like a comment-only diff
// (#1032), such a file is NOT COVERED and named, never a silent pass, and any
// other change in the same file keeps it eligible.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { fileChangeIsVersionOnly } from '../lib/targets.mjs';

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
const meta = (v, extra = '') => lines(
  `export const VERSION = '${v}';`,
  `export const DEPS = { core: "${v}", esbuild: '0.28.1' };`,
  `export function label() { return 'adlc ' + VERSION${extra}; }`,
  ''
);

const bump = { fromVersion: '1.11.1', toVersion: '1.12.0' };
const only = (oldSource, newSource, versions = bump) => fileChangeIsVersionOnly({ oldSource, newSource, ...versions });

describe('fileChangeIsVersionOnly', () => {
  it('is true when every changed literal is the release bump', () => {
    assert.equal(only(meta('1.11.1'), meta('1.12.0')), true);
  });

  it('is false for identical sources: nothing changed, so nothing is exempt', () => {
    assert.equal(only(meta('1.11.1'), meta('1.11.1')), false);
  });

  it('is false for a change with no version literal in it', () => {
    assert.equal(only(meta('1.11.1'), meta('1.11.1', " + '!'")), false);
  });

  it('is false when a version moved AND something else changed', () => {
    assert.equal(only(meta('1.11.1'), meta('1.12.0', " + '!'")), false);
  });

  it('is false for a behaviour-bearing threshold, even during a release', () => {
    const gate = (v) => `if (semver.lt(process.version, '${v}')) throw new Error('too old');\n`;
    assert.equal(only(gate('18.0.0'), gate('22.0.0')), false);
  });

  it('is false when a release-version literal moves to any value but the new release', () => {
    assert.equal(only(meta('1.11.1'), meta('9.9.9')), false);
    assert.equal(only(meta('1.11.1'), meta('1.12.0'), { fromVersion: '1.11.1', toVersion: '1.13.0' }), false);
  });

  it('is false when there is no release in the diff', () => {
    assert.equal(only(meta('1.11.1'), meta('1.12.0'), { fromVersion: '1.12.0', toVersion: '1.12.0' }), false);
    assert.equal(only(meta('1.11.1'), meta('1.12.0'), { fromVersion: undefined, toVersion: '1.12.0' }), false);
    assert.equal(only(meta('1.11.1'), meta('1.12.0'), { fromVersion: '1.11.1', toVersion: 'next' }), false);
  });

  it('is false when a three-part version becomes a two-part or four-part literal', () => {
    assert.equal(only(meta('1.11.1'), meta('1.12')), false);
    assert.equal(only(meta('1.11.1'), meta('1.12.0.1')), false);
  });

  it('does not treat a range, a bare number or an unquoted literal as a version', () => {
    assert.equal(only("const r = '^1.11.1';\n", "const r = '^1.12.0';\n"), false);
    assert.equal(only("const r = '>=1.11.1';\n", "const r = '>=1.12.0';\n"), false);
    assert.equal(only('// see 1.11.1\nlet a;\n', '// see 1.12.0\nlet a;\n'), false);
  });

  it('does not exempt an unquoted version that follows a quoted one', () => {
    // Between two quoted literals the bare version is a whole segment of its own.
    assert.equal(only("'1.0.0'1.11.1'2.0.0'", "'1.0.0'1.12.0'2.0.0'"), false);
  });

  it('does not treat a template literal as a version stamp', () => {
    assert.equal(only('const a = `1.11.1`;\n', 'const a = `1.12.0`;\n'), false);
  });

  it('requires the closing quote to match the opening one', () => {
    assert.equal(only(`const a = '1.11.1";\n`, `const a = '1.12.0";\n`), false);
    assert.equal(only("const a = `x'1.11.1`;\n", "const a = `x'1.12.0`;\n"), false);
  });

  it('does not treat a prerelease or a longer dotted token as a version', () => {
    assert.equal(only("const v = '1.11.1-rc';\n", "const v = '1.12.0-rc';\n"), false);
    assert.equal(only("const host = '1.11.1.4';\n", "const host = '1.12.0.4';\n"), false);
  });

  it('is false when a release-version literal is added or removed', () => {
    assert.equal(only('let a\n', 'let a\n1.12.0'), false);
    assert.equal(only('let a\n1.11.1', 'let a\n'), false);
  });

  it('is not fooled by a NUL byte where a literal used to be', () => {
    assert.equal(only("const a = '1.11.1';\n", "const a = '\0';\n"), false);
  });

  it('is false when either side is not a string', () => {
    assert.equal(only(null, meta('1.12.0')), false);
    assert.equal(only(meta('1.11.1'), undefined), false);
  });
});

// Every fixture the helper mints is removed when the file's tests finish.
const FIXTURES = [];
after(() => { for (const dir of FIXTURES.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(prefix, nextSource, nextVersion = '1.12.0') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  FIXTURES.push(dir);
  initRepo(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.11.1' }));
  writeFileSync(join(dir, 'src', 'meta.mjs'), meta('1.11.1'));
  writeFileSync(join(dir, 'test', 'meta.test.mjs'), lines(
    "import { it } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { label } from '../src/meta.mjs';",
    "it('labels', () => { assert.match(label(), /^adlc /); });",
    ''
  ));
  commitAll(dir, 'init');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: nextVersion }));
  writeFileSync(join(dir, 'src', 'meta.mjs'), nextSource);
  commitAll(dir, 'bump');
  return dir;
}

const BASE_ARGS = ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1'];
const ARGS = [...BASE_ARGS, '--generated', 'src/meta.mjs'];

describe('CLI: a release-bump-only diff is reported as not covered, not a failure', () => {
  let dir;
  before(() => { dir = fixture('hollow-versiononly-', meta('1.12.0')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('exits 0 and names the file and the reason', () => {
    const r = runCli(ARGS, dir);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /changed only version literals[\s\S]*src\/meta\.mjs/);
  });

  it('lists the file under skipped.versionOnly in the JSON report', () => {
    const r = runCli([...ARGS, '--json'], dir);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout).skipped, { versionOnly: ['src/meta.mjs'] });
  });
});

for (const [name, prefix, source, version, args] of [
  ['a version bump mixed with a code change', 'hollow-versionmixed-', meta('1.12.0', " + '!'"), '1.12.0', ARGS],
  ['a version literal moved without a release', 'hollow-versionnorelease-', meta('1.12.0'), '1.11.1', ARGS],
  ['a release bump in a file not named --generated', 'hollow-versionnotgenerated-', meta('1.12.0'), '1.12.0', BASE_ARGS],
]) {
  describe(`CLI: ${name} is still mutated`, () => {
    let dir;
    before(() => { dir = fixture(prefix, source, version); });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('runs mutants on the file and does not report it as version-only', () => {
      const r = runCli([...args, '--json'], dir);
      const out = r.stdout + r.stderr;
      assert.doesNotMatch(out, /versionOnly|changed only version literals/, out);
      // 0 (all killed) or 2 (survivors) both mean the file was mutated; 1 is an operational refusal.
      assert.ok(r.status === 0 || r.status === 2, out);
      assert.ok(JSON.parse(r.stdout).summary.total > 0, out);
    });
  });
}

// Enough unchanged lines that git pairs the two paths as a rename.
const padded = (v) => meta(v) + Array.from({ length: 12 }, (_, i) => `export const k${i} = ${i};`).join('\n') + '\n';

describe('CLI: a rename onto a --generated path is still mutated', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-versionrename-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.11.1' }));
    writeFileSync(join(dir, 'src', 'other.mjs'), padded('1.11.1'));
    writeFileSync(join(dir, 'test', 'meta.test.mjs'), lines(
      "import { it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { label } from '../src/meta.mjs';",
      "it('labels', () => { assert.match(label(), /^adlc /); });",
      ''
    ));
    commitAll(dir, 'init');
    // other.mjs moves onto the generated path with only its stamps bumped, so
    // git reports a rename whose old side is a different file.
    git(['mv', 'src/other.mjs', 'src/meta.mjs'], dir);
    writeFileSync(join(dir, 'src', 'meta.mjs'), padded('1.12.0'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.12.0' }));
    commitAll(dir, 'rename');
    assert.match(git(['diff', '--name-status', 'HEAD~1', 'HEAD'], dir), /^R\d+\tsrc\/other\.mjs\tsrc\/meta\.mjs$/m);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('does not report the renamed file as version-only', () => {
    const r = runCli([...ARGS, '--json'], dir);
    const out = r.stdout + r.stderr;
    assert.doesNotMatch(out, /versionOnly|changed only version literals/, out);
    assert.ok(r.status === 0 || r.status === 2, out);
  });
});
