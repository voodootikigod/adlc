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

describe('fileChangeIsVersionOnly', () => {
  it('is true when only version literals moved', () => {
    assert.equal(fileChangeIsVersionOnly({ oldSource: meta('1.11.1'), newSource: meta('1.12.0') }), true);
  });

  it('is false for identical sources: nothing changed, so nothing is exempt', () => {
    assert.equal(fileChangeIsVersionOnly({ oldSource: meta('1.11.1'), newSource: meta('1.11.1') }), false);
  });

  it('is false for a change with no version literal in it', () => {
    assert.equal(fileChangeIsVersionOnly({ oldSource: meta('1.11.1'), newSource: meta('1.11.1', " + '!'") }), false);
  });

  it('is false when a version moved AND something else changed', () => {
    assert.equal(fileChangeIsVersionOnly({ oldSource: meta('1.11.1'), newSource: meta('1.12.0', " + '!'") }), false);
  });

  it('is false when a three-part version becomes a two-part or four-part literal', () => {
    assert.equal(fileChangeIsVersionOnly({ oldSource: meta('1.11.1'), newSource: meta('1.12') }), false);
    assert.equal(fileChangeIsVersionOnly({ oldSource: meta('1.11.1'), newSource: meta('1.12.0.1') }), false);
  });

  it('is false when a number inside a longer dotted token changes', () => {
    const oldSource = "const host = '10.0.0.1';\n";
    const newSource = "const host = '10.0.0.2';\n";
    assert.equal(fileChangeIsVersionOnly({ oldSource, newSource }), false);
  });

  it('is false when either side is not a string', () => {
    assert.equal(fileChangeIsVersionOnly({ oldSource: null, newSource: meta('1.12.0') }), false);
    assert.equal(fileChangeIsVersionOnly({ oldSource: meta('1.11.1'), newSource: undefined }), false);
  });
});

function fixture(prefix, nextSource) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  initRepo(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src', 'meta.mjs'), meta('1.11.1'));
  writeFileSync(join(dir, 'test', 'meta.test.mjs'), lines(
    "import { it } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { label } from '../src/meta.mjs';",
    "it('labels', () => { assert.match(label(), /^adlc /); });",
    ''
  ));
  commitAll(dir, 'init');
  writeFileSync(join(dir, 'src', 'meta.mjs'), nextSource);
  commitAll(dir, 'bump');
  return dir;
}

describe('CLI: a version-only diff is reported as not covered, not a failure', () => {
  let dir;
  before(() => { dir = fixture('hollow-versiononly-', meta('1.12.0')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('exits 0 and names the file and the reason', () => {
    const r = runCli(['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1'], dir);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /changed only version literals[\s\S]*src\/meta\.mjs/);
  });

  it('lists the file under skipped.versionOnly in the JSON report', () => {
    const r = runCli(['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--json'], dir);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout).skipped, { versionOnly: ['src/meta.mjs'] });
  });
});

describe('CLI: a version bump mixed with a code change stays eligible', () => {
  let dir;
  before(() => { dir = fixture('hollow-versionmixed-', meta('1.12.0', " + '!'")); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('does not take the version-only path', () => {
    const r = runCli(['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1'], dir);
    assert.doesNotMatch(r.stdout + r.stderr, /changed only version literals/,
      `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  });
});
