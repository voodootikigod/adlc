// rails-guard-bootstrap-ci.test.mjs - regression tests for the bootstrap and
// signed-mode checks embedded in docs/ci/rails-guard.yml.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(ROOT, 'docs', 'ci', 'rails-guard.yml');

function extractBootstrapScript() {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const marker = '- name: Verify ADLC bootstrap acknowledgement';
  const markerAt = workflow.indexOf(marker);
  assert.notEqual(markerAt, -1, 'bootstrap step marker exists');
  const startToken = "node -e '\n";
  const start = workflow.indexOf(startToken, markerAt);
  assert.notEqual(start, -1, 'bootstrap node -e block exists');
  const codeStart = start + startToken.length;
  const end = workflow.indexOf("\n          '", codeStart);
  assert.notEqual(end, -1, 'bootstrap node -e block terminates');
  return workflow
    .slice(codeStart, end)
    .split('\n')
    .map((line) => (line.startsWith('            ') ? line.slice(12) : line))
    .join('\n');
}

const BOOTSTRAP_SCRIPT = extractBootstrapScript();

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runBootstrapScenario({ baseConfig, headConfig, env = {}, mutateBase, mutateHead }) {
  const dir = mkdtempSync(join(tmpdir(), 'rg-bootstrap-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeJson(join(dir, '.adlc', 'config.json'), baseConfig);
    mutateBase?.(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(dir, ['checkout', '-q', '-b', 'feat']);
    writeJson(join(dir, '.adlc', 'config.json'), headConfig ?? baseConfig);
    mutateHead?.(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--allow-empty', '-qm', 'change']);

    const scenarioEnv = typeof env === 'function' ? env(dir) : env;
    const result = spawnSync(process.execPath, ['-e', BOOTSTRAP_SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BASE_REF: 'main', ADLC_RUNNER_PATH: '', ...scenarioEnv },
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE_UNSIGNED = {
  acknowledgedNewRailBypass: true,
  securityMode: 'unsigned-fallback',
  signers: {
    alice: { role: 'builder' },
  },
  revokedKeys: ['old-key'],
  securitySensitivePatterns: ['src/security/**'],
  maxBundleAgeDays: 14,
};

test('new signer entries reject undeclared properties', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: {
      ...BASE_UNSIGNED,
      signers: {
        ...BASE_UNSIGNED.signers,
        bob: { role: 'critic', canApproveIf: true },
      },
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new signer bob has undeclared property canApproveIf/);
});

test('new signer entries may add only builder or critic roles', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: {
      ...BASE_UNSIGNED,
      signers: {
        ...BASE_UNSIGNED.signers,
        bob: { roles: ['builder', 'critic'] },
      },
    },
  });
  assert.equal(result.status, 0);
});

test('new approver signer roles require the protected-base admin ceremony', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: {
      ...BASE_UNSIGNED,
      signers: {
        ...BASE_UNSIGNED.signers,
        bob: { role: 'approver' },
      },
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /grant approver roles through the protected-base admin ceremony/);
});

test('signed base config cannot be downgraded in a PR', () => {
  const signedBase = {
    ...BASE_UNSIGNED,
    securityMode: 'signed',
    runnerBinarySha256: '0'.repeat(64),
  };
  const result = runBootstrapScenario({
    baseConfig: signedBase,
    headConfig: {
      ...signedBase,
      securityMode: 'unsigned-fallback',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot downgrade securityMode from signed to unsigned-fallback/);
});

test('signed mode reports a clear error when ADLC_RUNNER_PATH is absent on the runner', () => {
  const signedBase = {
    ...BASE_UNSIGNED,
    securityMode: 'signed',
    runnerBinarySha256: '0'.repeat(64),
  };
  const missingRunner = join(tmpdir(), 'adlc-runner-does-not-exist');
  const result = runBootstrapScenario({
    baseConfig: signedBase,
    headConfig: signedBase,
    env: { ADLC_RUNNER_PATH: missingRunner },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADLC_RUNNER_PATH .* does not exist/);
  assert.match(result.stderr, /dedicated signed-mode runner pool/);
});

test('signed mode rejects runner hash mismatches before executing the runner', () => {
  const signedBase = {
    ...BASE_UNSIGNED,
    securityMode: 'signed',
    runnerBinarySha256: '0'.repeat(64),
  };
  const result = runBootstrapScenario({
    baseConfig: signedBase,
    headConfig: signedBase,
    mutateHead: (dir) => writeFileSync(join(dir, 'runner.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 }),
    env: (dir) => ({ ADLC_RUNNER_PATH: join(dir, 'runner.sh') }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADLC_RUNNER_PATH sha256 does not match runnerBinarySha256/);
});
