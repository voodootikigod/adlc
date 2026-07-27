// The `adlc rails-guard-ci` entry point (#140).
//
// The bin translates a verdict into an EXIT CODE, which is the only thing CI reads. A
// bug here is invisible in every other test: the gate can decide correctly and still
// report a pass. So these spawn the real bin and assert the process exit status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rails-guard-ci.mjs');

function run(args, { cwd = tmpdir(), env = {} } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, RAILS_BASE: '', BASE_REF: '', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// A malformed invocation must FAIL the job. `process.exit(null)` exits 0, so a
// non-numeric return from the arg-error path would turn a typo into a silent pass.
test('a malformed invocation exits non-zero, never 0', () => {
  const result = run(['--trust-roots', 'oops']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unrecognized argument: --trust-roots/);
});

test('a value-less --base exits 1 rather than resolving to nothing', () => {
  const result = run(['--base']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--base requires a ref/);
});

test('--help exits 0 and documents both entry points and every flag', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /adlc rails-guard-ci \[--base <ref>\] \[--trust-root <path>\]/);
  assert.match(result.stdout, /adlc rails-guard-ci bootstrap \[--base <ref>\]/);
  // The exit-code contract is the interface CI depends on; it must stay documented.
  assert.match(result.stdout, /0 pass/);
  assert.match(result.stdout, /1 operational error/);
  assert.match(result.stdout, /2 rail or trust root violated/);
});

// An unresolvable base is the classic fail-OPEN: `git show <bad-ref>:<path>` is
// indistinguishable from "path absent", which would read as "nothing is frozen".
test('an unresolvable base ref fails closed with exit 1, not a pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-bin-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'x'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });

    const result = run(['--base', 'origin/does-not-exist'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not resolve/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// unsigned-fallback is the mode every repo bootstraps in. If it stopped being a
// recognized securityMode, ordinary repos would fail the gate outright.
test('bootstrap accepts unsigned-fallback as a valid securityMode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-bin-mode-'));
  try {
    const config = {
      acknowledgedNewRailBypass: true,
      trustedCodeownersAttested: true,
      securityMode: 'unsigned-fallback',
    };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'x'], { cwd: dir });
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'CODEOWNERS'), '.github/workflows/adlc-rails-guard.yml @adlc-admins\n');
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify(config));
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
    execFileSync('git', ['checkout', '-q', '-b', 'feat'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'change'], { cwd: dir });

    const ok = run(['bootstrap'], { cwd: dir, env: { BASE_REF: 'main' } });
    assert.equal(ok.status, 0, ok.stderr);

    // And an unrecognized mode is still refused, so the check above is not vacuous.
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify({ ...config, securityMode: 'anything-goes' }));
    execFileSync('git', ['commit', '-qam', 'bad mode'], { cwd: dir });
    const bad = run(['bootstrap'], { cwd: dir, env: { BASE_REF: 'main' } });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /securityMode must be signed or unsigned-fallback/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
