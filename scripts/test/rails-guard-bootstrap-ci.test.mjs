// rails-guard-bootstrap-ci.test.mjs — regression tests for the bootstrap and
// signed-mode checks of the CI rail-freeze gate.
//
// These used to run a script EXTRACTED from docs/ci/rails-guard.yml, because the gate
// was inlined there as a `node -e` block. Since #140 there is one implementation —
// `adlc rails-guard-ci`, shipped in @adlc/rails-guard — and the template merely calls
// it. So the scenarios below run the real bin, which is what CI runs, and the template
// is checked for the one thing it still owns: that it invokes the right commands with
// the right environment.
//
// The old sha256 fixture (scripts/test/rails-guard-workflow-hashes.json) is gone with
// the copy it pinned. It could only prove the inline script was UNCHANGED, never that
// it AGREED with the real gate — and they had already drifted (#314).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketFilename } from '@adlc/tickets';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(ROOT, 'docs', 'ci', 'rails-guard.yml');
const GATE_BIN = join(ROOT, 'packages', 'rails-guard', 'bin', 'rails-guard-ci.mjs');

function extractStepYaml(marker) {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const markerAt = workflow.indexOf(marker);
  assert.notEqual(markerAt, -1, `${marker} marker exists`);
  const nextStep = workflow.indexOf('\n      - name:', markerAt + marker.length);
  return workflow.slice(markerAt, nextStep === -1 ? undefined : nextStep);
}

// The template's whole job is now dispatch. If it stops calling the gate — or calls it
// without the base ref — every scenario below still passes while CI enforces nothing,
// so the wiring is asserted explicitly rather than assumed.
test('workflow template invokes the shipped gate rather than an inline copy', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(extractStepYaml('- name: Verify ADLC bootstrap acknowledgement'), /run: adlc rails-guard-ci bootstrap\b/);
  assert.match(extractStepYaml('- name: Rail-freeze gate'), /run: adlc rails-guard-ci\s*$/m);
  // Scan the executable `run:` lines only — the file's header legitimately mentions the
  // `node -e` block it replaced, and matching prose would make this assertion a spelling test.
  const runLines = workflow.split('\n').filter((line) => /^\s*run:/.test(line));
  assert.ok(runLines.length > 0, 'the workflow has run: steps');
  for (const line of runLines) {
    assert.doesNotMatch(line, /node\s+-e/, `the gate must not be inlined into the template again: ${line.trim()}`);
  }
});

test('workflow template pins an exact @adlc/cli version, never a floating tag', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /npm install -g --ignore-scripts @adlc\/cli@\d+\.\d+\.\d+/);
  assert.doesNotMatch(workflow, /@adlc\/cli@latest/);
});

// Both gate steps need BASE_REF: the bin derives origin/$BASE_REF from it. A step that
// lost it would silently fall back to origin/main and diff against the wrong base.
test('both gate steps receive BASE_REF', () => {
  assert.match(extractStepYaml('- name: Verify ADLC bootstrap acknowledgement'), /BASE_REF:\s*\$\{\{\s*github\.base_ref\s*\}\}/);
  assert.match(extractStepYaml('- name: Rail-freeze gate'), /BASE_REF:\s*\$\{\{\s*github\.base_ref\s*\}\}/);
});

test('bootstrap workflow env maps signed-mode values from the expected GitHub contexts', () => {
  const step = extractStepYaml('- name: Verify ADLC bootstrap acknowledgement');
  assert.match(step, /BASE_REF:\s*\$\{\{\s*github\.base_ref\s*\}\}/);
  assert.match(step, /ADLC_RUNNER_PATH:\s*\$\{\{\s*secrets\.ADLC_RUNNER_PATH\s*\}\}/);
  assert.match(step, /ADLC_SIGNED_RUNNER_POOL:\s*\$\{\{\s*vars\.ADLC_SIGNED_RUNNER_POOL\s*\}\}/);
  assert.match(step, /RUNNER_ENVIRONMENT:\s*\$\{\{\s*runner\.environment\s*\}\}/);
});

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Ambient inputs the gate honors that these scenarios must NOT inherit from whoever ran the
// suite. Each scenario builds a throwaway repo and describes the base ref itself, so any of
// these arriving from the outside describes a repo that does not exist here.
//
//   RAILS_BASE        LOAD-BEARING. It outranks BASE_REF in defaultBase() (lib/ci/args.mjs), so
//                     an operator who exported it — routine when driving the gate by hand across
//                     parallel worktrees — silently retargets every scenario at a branch the
//                     synthetic repo has never heard of. Measured: 75 of 80 tests fail, all
//                     exit 1. Pinning it here is what makes that impossible.
//   GITHUB_EVENT_PATH DEFENSIVE, not a fix for an observed failure. It is ALWAYS set under GitHub
//   ADLC_PR_REVIEWS   Actions, where it makes readPrContext() return a real PR context instead of
//                     the null a local run sees. Measured, the suite passes 80/80 either way
//                     today, so no current assertion depends on the difference — these are pinned
//                     so the CI and local code paths cannot silently diverge later.
//
// Spread BEFORE each scenario's own `env`, so a test that deliberately supplies one still wins.
// This mirrors packages/rails-guard/test/ci-bin.test.mjs, which already pins RAILS_BASE/BASE_REF.
const HERMETIC_ENV = {
  RAILS_BASE: '',
  GITHUB_EVENT_PATH: '',
  ADLC_PR_REVIEWS: '',
};

function runBootstrapScenario({ baseConfig, headConfig, env = {}, mutateBase, mutateHead, withCodeowners = true, codeownersContent = '.github/workflows/adlc-rails-guard.yml @adlc-admins\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'rg-bootstrap-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    if (withCodeowners) {
      mkdirSync(join(dir, '.github'), { recursive: true });
      writeFileSync(join(dir, '.github', 'CODEOWNERS'), codeownersContent);
    }
    if (baseConfig === null) {
      writeFileSync(join(dir, 'README.md'), 'bootstrap\n');
    } else {
      mkdirSync(join(dir, '.adlc'), { recursive: true });
      writeJson(join(dir, '.adlc', 'config.json'), baseConfig);
    }
    mutateBase?.(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(dir, ['checkout', '-q', '-b', 'feat']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeJson(join(dir, '.adlc', 'config.json'), headConfig ?? baseConfig);
    mutateHead?.(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--allow-empty', '-qm', 'change']);

    const scenarioEnv = typeof env === 'function' ? env(dir) : env;
    const result = spawnSync(process.execPath, [GATE_BIN, 'bootstrap'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...HERMETIC_ENV,
        BASE_REF: 'main',
        ADLC_RUNNER_PATH: '',
        RUNNER_ENVIRONMENT: 'github-hosted',
        ADLC_SIGNED_RUNNER_POOL: '',
        ...scenarioEnv,
      },
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

function runRailFreezeScenario({ baseConfig = BASE_UNSIGNED, baseTickets, headConfig, env = {}, mutateBase, mutateHead }) {
  const dir = mkdtempSync(join(tmpdir(), 'rg-rail-freeze-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    if (baseConfig === null) {
      writeFileSync(join(dir, 'README.md'), 'bootstrap\n');
    } else {
      mkdirSync(join(dir, '.adlc'), { recursive: true });
      if (baseConfig !== false) writeJson(join(dir, '.adlc', 'config.json'), baseConfig);
      if (baseTickets !== undefined) writeJson(join(dir, '.adlc', 'tickets.json'), baseTickets);
    }
    mutateBase?.(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(dir, ['checkout', '-q', '-b', 'feat']);
    if (headConfig !== undefined) {
      mkdirSync(join(dir, '.adlc'), { recursive: true });
      writeJson(join(dir, '.adlc', 'config.json'), headConfig);
    }
    mutateHead?.(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--allow-empty', '-qm', 'change']);

    const scenarioEnv = typeof env === 'function' ? env(dir) : env;
    const result = spawnSync(process.execPath, [GATE_BIN], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...HERMETIC_ENV, BASE_REF: 'main', ...scenarioEnv },
    });
    return {
      cwd: dir,
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
  trustedCodeownersAttested: true,
  securityMode: 'unsigned-fallback',
  signers: {
    alice: { role: 'builder' },
  },
  revokedKeys: ['old-key'],
  securitySensitivePatterns: ['src/security/**'],
  maxBundleAgeDays: 14,
};

test('clean unsigned-fallback PR with unchanged config exits 0', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
  });
  assert.equal(result.status, 0);
});

test('bootstrap step requires trusted CODEOWNERS attestation on base config', () => {
  const result = runBootstrapScenario({
    baseConfig: { ...BASE_UNSIGNED, trustedCodeownersAttested: false },
    headConfig: BASE_UNSIGNED,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /trustedCodeownersAttested: true/);
});

test('bootstrap step rejects trusted CODEOWNERS attestation removal in PR', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: { ...BASE_UNSIGNED, trustedCodeownersAttested: false },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /trustedCodeownersAttested cannot be removed/);
});

test('bootstrap step requires CODEOWNERS protection for the deployed workflow', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    withCodeowners: false,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing CODEOWNERS entry protecting \.github\/workflows\/adlc-rails-guard\.yml/);
});

test('first bootstrap can land before CODEOWNERS is present on base', () => {
  const result = runBootstrapScenario({
    baseConfig: null,
    headConfig: BASE_UNSIGNED,
    withCodeowners: false,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /configure CODEOWNERS protection before marking the check required/);
});

test('bootstrap step accepts catch-all CODEOWNERS protection', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    codeownersContent: '* @adlc-admins\n',
  });
  assert.equal(result.status, 0);
});

test('bootstrap step rejects CODEOWNERS catch-all negated for the deployed workflow', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    codeownersContent: '* @adlc-admins\n!.github/workflows/adlc-rails-guard.yml\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing CODEOWNERS entry protecting \.github\/workflows\/adlc-rails-guard\.yml/);
});

test('bootstrap step accepts CODEOWNERS negation before later catch-all owners', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    codeownersContent: '!.github/workflows/adlc-rails-guard.yml\n* @adlc-admins\n',
  });
  assert.equal(result.status, 0);
});

test('bootstrap step accepts CODEOWNERS wildcard owners for the deployed workflow', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    codeownersContent: '.github/workflows/*.yml @adlc-admins\n',
  });
  assert.equal(result.status, 0);
});

test('bootstrap step follows GitHub CODEOWNERS file priority', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    codeownersContent: '* @adlc-admins\n',
    mutateBase: (dir) => writeFileSync(join(dir, 'CODEOWNERS'), 'src/** @app-team\n'),
  });
  assert.equal(result.status, 0);
});

test('bootstrap step treats root CODEOWNERS as higher priority than docs CODEOWNERS', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    withCodeowners: false,
    mutateBase: (dir) => {
      writeFileSync(join(dir, 'CODEOWNERS'), 'src/** @app-team\n');
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'CODEOWNERS'), '* @adlc-admins\n');
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing CODEOWNERS entry protecting \.github\/workflows\/adlc-rails-guard\.yml/);
});

test('bootstrap step treats .github CODEOWNERS as higher priority than docs CODEOWNERS', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    codeownersContent: '* @adlc-admins\n',
    mutateBase: (dir) => {
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'CODEOWNERS'), 'src/** @app-team\n');
    },
  });
  assert.equal(result.status, 0);
});

test('bootstrap step treats .github CODEOWNERS as higher priority than root CODEOWNERS', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    codeownersContent: '!.github/workflows/adlc-rails-guard.yml\n',
    mutateBase: (dir) => writeFileSync(join(dir, 'CODEOWNERS'), '* @adlc-admins\n'),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing CODEOWNERS entry protecting \.github\/workflows\/adlc-rails-guard\.yml/);
});

test('bootstrap step rejects workflow CODEOWNERS entries with no owners', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    codeownersContent: '.github/workflows/adlc-rails-guard.yml\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing CODEOWNERS entry protecting \.github\/workflows\/adlc-rails-guard\.yml/);
});

test('bootstrap step rejects no-owner CODEOWNERS override after catch-all owners', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    codeownersContent: '.github/ @adlc-admins\n.github/workflows/adlc-rails-guard.yml\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing CODEOWNERS entry protecting \.github\/workflows\/adlc-rails-guard\.yml/);
});

test('bootstrap step rejects wildcard no-owner override after catch-all owners', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    codeownersContent: '* @adlc-admins\n.github/workflows/*.yml\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing CODEOWNERS entry protecting \.github\/workflows\/adlc-rails-guard\.yml/);
});

test('new signer entries reject undeclared properties', () => {
  const result = runBootstrapScenario({
    baseConfig: null,
    withCodeowners: false,
    headConfig: {
      ...BASE_UNSIGNED,
      signers: {
        bob: { role: 'critic', canApproveIf: true },
      },
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new signer bob has undeclared property canApproveIf/);
});

test('new signer entries must declare role information', () => {
  const result = runBootstrapScenario({
    baseConfig: null,
    withCodeowners: false,
    headConfig: {
      ...BASE_UNSIGNED,
      signers: {
        bob: {},
      },
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new signer bob must declare a role or roles field/);
});

test('new signer entries may add only builder or critic roles', () => {
  const result = runBootstrapScenario({
    baseConfig: null,
    withCodeowners: false,
    headConfig: {
      ...BASE_UNSIGNED,
      signers: {
        bob: { roles: ['builder', 'critic'] },
      },
    },
  });
  assert.equal(result.status, 0);
});

test('post-bootstrap signer additions require the protected-base admin ceremony', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: {
      ...BASE_UNSIGNED,
      signers: {
        ...BASE_UNSIGNED.signers,
        bob: { role: 'critic' },
      },
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new signer bob requires the protected-base admin ceremony/);
});

test('new approver signer roles require the protected-base admin ceremony', () => {
  const result = runBootstrapScenario({
    baseConfig: null,
    withCodeowners: false,
    headConfig: {
      ...BASE_UNSIGNED,
      signers: {
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
    env: {
      ADLC_RUNNER_PATH: missingRunner,
      RUNNER_ENVIRONMENT: 'self-hosted',
      ADLC_SIGNED_RUNNER_POOL: '1',
    },
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
    env: (dir) => ({
      ADLC_RUNNER_PATH: join(dir, 'runner.sh'),
      RUNNER_ENVIRONMENT: 'self-hosted',
      ADLC_SIGNED_RUNNER_POOL: '1',
    }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADLC_RUNNER_PATH sha256 does not match runnerBinarySha256/);
});

test('signed mode accepts a matching runner that passes all probes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'adlc-runner-ok-'));
  try {
    const runnerPath = join(tmp, 'adlc-runner');
    writeFileSync(
      runnerPath,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then exit 0; fi',
        'if [ "$2" = "--help" ]; then',
        '  case "$1" in',
        '    record|run|accept|upgrade) exit 0 ;;',
        '  esac',
        'fi',
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o700 }
    );
    const digest = createHash('sha256').update(readFileSync(runnerPath)).digest('hex');
    const signedBase = {
      ...BASE_UNSIGNED,
      securityMode: 'signed',
      runnerBinarySha256: digest,
    };
    const result = runBootstrapScenario({
      baseConfig: signedBase,
      headConfig: signedBase,
      env: {
        ADLC_RUNNER_PATH: runnerPath,
        RUNNER_ENVIRONMENT: 'self-hosted',
        ADLC_SIGNED_RUNNER_POOL: '1',
      },
    });
    assert.equal(result.status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('revokedKeys entries cannot be removed in a PR', () => {
  const result = runBootstrapScenario({
    baseConfig: { ...BASE_UNSIGNED, revokedKeys: ['old-key', 'compromised-key'] },
    headConfig: { ...BASE_UNSIGNED, revokedKeys: ['old-key'] },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /revokedKeys cannot remove trusted entry/);
});

test('securitySensitivePatterns entries cannot be removed in a PR', () => {
  const result = runBootstrapScenario({
    baseConfig: {
      ...BASE_UNSIGNED,
      securitySensitivePatterns: ['src/security/**', 'packages/gate-manifest/**'],
    },
    headConfig: {
      ...BASE_UNSIGNED,
      securitySensitivePatterns: ['src/security/**'],
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /securitySensitivePatterns cannot remove trusted entry/);
});

test('maxBundleAgeDays can only decrease or stay the same', () => {
  const result = runBootstrapScenario({
    baseConfig: { ...BASE_UNSIGNED, maxBundleAgeDays: 14 },
    headConfig: { ...BASE_UNSIGNED, maxBundleAgeDays: 30 },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /maxBundleAgeDays can only decrease or stay the same/);
});

test('signedEvidenceRequired cannot be removed when it is trusted true', () => {
  const signedRequiredBase = {
    ...BASE_UNSIGNED,
    securityMode: 'signed',
    signedEvidenceRequired: true,
    runnerBinarySha256: '0'.repeat(64),
  };
  const result = runBootstrapScenario({
    baseConfig: signedRequiredBase,
    headConfig: {
      ...signedRequiredBase,
      signedEvidenceRequired: false,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot remove signedEvidenceRequired/);
});

test('signedEvidenceRequired cannot be added in a PR without the protected-base runner ceremony', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: {
      ...BASE_UNSIGNED,
      securityMode: 'signed',
      signedEvidenceRequired: true,
      runnerBinarySha256: '0'.repeat(64),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /signed mode upgrade requires a protected-base runner ceremony/);
});

test('runnerBinarySha256 cannot change in a PR', () => {
  const signedBase = {
    ...BASE_UNSIGNED,
    securityMode: 'signed',
    runnerBinarySha256: '0'.repeat(64),
  };
  const result = runBootstrapScenario({
    baseConfig: signedBase,
    headConfig: {
      ...signedBase,
      runnerBinarySha256: '1'.repeat(64),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runnerBinarySha256 cannot change in a PR/);
});

test('existing signer roles cannot change in a PR', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: {
      ...BASE_UNSIGNED,
      signers: {
        alice: { role: 'critic' },
      },
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /signers\.alice\.role cannot change trusted signer property/);
});

test('existing signer keys cannot be deleted in a PR', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: {
      ...BASE_UNSIGNED,
      signers: {},
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /signers\.alice must remain an object/);
});

test('existing signers field cannot be removed in a PR', () => {
  const { signers: _signers, ...headConfig } = BASE_UNSIGNED;
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /signers must remain an object/);
});

test('existing signer role arrays cannot gain approver roles in a PR', () => {
  const baseConfig = {
    ...BASE_UNSIGNED,
    signers: {
      alice: { roles: ['builder'] },
    },
  };
  const result = runBootstrapScenario({
    baseConfig,
    headConfig: {
      ...baseConfig,
      signers: {
        alice: { roles: ['builder', 'approver'] },
      },
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /signers\.alice\.roles cannot change trusted signer property/);
});

test('unchanged existing signer role arrays pass validation', () => {
  const baseConfig = {
    ...BASE_UNSIGNED,
    signers: {
      alice: { roles: ['builder'] },
    },
  };
  const result = runBootstrapScenario({
    baseConfig,
    headConfig: baseConfig,
  });
  assert.equal(result.status, 0);
});

test('HEAD config must acknowledge the new-rail limitation', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: {
      ...BASE_UNSIGNED,
      acknowledgedNewRailBypass: false,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing acknowledgedNewRailBypass: true/);
});

test('first bootstrap mode rejects pre-populated manifest evidence', () => {
  const result = runBootstrapScenario({
    baseConfig: null,
    headConfig: BASE_UNSIGNED,
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '{"prepopulated":true}\n'),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /first bootstrap PR cannot introduce pre-populated \.adlc\/manifest\.jsonl evidence/);
});

test('first bootstrap mode accepts a clean unsigned-fallback config', () => {
  const result = runBootstrapScenario({
    baseConfig: null,
    headConfig: BASE_UNSIGNED,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /bootstrap mode: base has no \.adlc tree/);
});

test('first bootstrap mode rejects signed security mode before runner infrastructure is validated', () => {
  const result = runBootstrapScenario({
    baseConfig: null,
    headConfig: {
      ...BASE_UNSIGNED,
      securityMode: 'signed',
      runnerBinarySha256: '0'.repeat(64),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bootstrap with securityMode signed requires the adlc-signed runner pool/);
});

test('signed mode requires the dedicated self-hosted runner pool sentinel', () => {
  const signedBase = {
    ...BASE_UNSIGNED,
    securityMode: 'signed',
    runnerBinarySha256: '0'.repeat(64),
  };
  const result = runBootstrapScenario({
    baseConfig: signedBase,
    headConfig: signedBase,
    env: {
      ADLC_RUNNER_PATH: join(tmpdir(), 'adlc-runner-does-not-exist'),
      RUNNER_ENVIRONMENT: 'github-hosted',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dedicated adlc-signed self-hosted runner pool/);
});

test('signed mode rejects self-hosted runners missing the signed-pool sentinel', () => {
  const signedBase = {
    ...BASE_UNSIGNED,
    securityMode: 'signed',
    runnerBinarySha256: '0'.repeat(64),
  };
  const result = runBootstrapScenario({
    baseConfig: signedBase,
    headConfig: signedBase,
    env: {
      RUNNER_ENVIRONMENT: 'self-hosted',
      ADLC_SIGNED_RUNNER_POOL: '',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dedicated adlc-signed self-hosted runner pool/);
});

test('base config must already acknowledge the new-rail limitation', () => {
  const result = runBootstrapScenario({
    baseConfig: {
      ...BASE_UNSIGNED,
      acknowledgedNewRailBypass: false,
    },
    headConfig: BASE_UNSIGNED,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /acknowledgedNewRailBypass must already be set on the base branch/);
});

test('rail-freeze bootstrap mode rejects pre-populated first-bootstrap manifest evidence', () => {
  const result = runRailFreezeScenario({
    baseConfig: null,
    headConfig: BASE_UNSIGNED,
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '{"prepopulated":true}\n'),
  });
  // The template's inline copy exited 0 here and deferred to the bootstrap step. The
  // shared gate is stricter: it makes the same diff-based judgement the script always
  // did, so the check no longer depends on step ordering.
  assert.equal(result.status, 1);
  assert.match(result.stderr, /first bootstrap PR cannot introduce pre-populated \.adlc\/manifest\.jsonl evidence/);
});

// A base with a .adlc tree but no config.json is half-bootstrapped. That verdict belongs
// to the BOOTSTRAP step, which the workflow template runs before the rail-freeze step —
// so a deployed workflow still fails closed on it. The rail-freeze step deliberately does
// NOT require a config, because this repository runs it that way: the ADLC repo has a
// committed .adlc/ ticket store and no .adlc/config.json at all.
test('bootstrap step fails closed when base .adlc exists without config acknowledgement', () => {
  const result = runBootstrapScenario({
    baseConfig: null,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => {
      mkdirSync(join(dir, '.adlc'), { recursive: true });
      writeJson(join(dir, '.adlc', 'tickets.json'), { tickets: [] });
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /base \.adlc\/config\.json is absent/);
});

// A repo whose tickets declare NO rails is still not unprotected: the immutable trust
// roots freeze as soon as the base is bootstrapped. Before, this was asserted by reading
// the argv handed to a stubbed `adlc`; now it is asserted by the verdict.
test('rail-freeze gate protects trust roots when base tickets declare no rails', () => {
  const denied = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: [] }] },
    headConfig: BASE_UNSIGNED,
    mutateBase: editAtHead('.github/workflows/adlc-rails-guard.yml', 'name: gate\n'),
    mutateHead: editAtHead('.github/workflows/adlc-rails-guard.yml', 'name: tampered\n'),
  });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /ADLC trust root changed, deleted, or renamed/);

  // Control: with no rails declared, an ordinary file is NOT frozen. Without this the
  // test above would also pass if the gate denied everything.
  const allowed = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: [] }] },
    headConfig: BASE_UNSIGNED,
    mutateHead: editAtHead('src/ordinary.txt'),
  });
  assert.equal(allowed.status, 0);
});

test('rail-freeze gate allows adding a new ticket while preserving existing tickets', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }] },
    headConfig: BASE_UNSIGNED,
    mutateHead: (dir) =>
      writeJson(join(dir, '.adlc', 'tickets.json'), {
        tickets: [
          { id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] },
          { id: 'T2', title: 'Fixture T2', rails: [] },
        ],
      }),
  });
  assert.equal(result.status, 0);
});

test('rail-freeze gate rejects ticket updates that remove base rails', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }] },
    headConfig: BASE_UNSIGNED,
    mutateHead: (dir) => writeJson(join(dir, '.adlc', 'tickets.json'), { tickets: [{ id: 'T1', title: 'Fixture T1', rails: [] }] }),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /contract cannot change in \.adlc\/tickets\.json/);
});

test('rail-freeze gate rejects existing ticket contract changes that preserve rails', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', triageClass: 'Substantial', triageCommit: 'abc123', rails: ['src/critical/**'] }] },
    headConfig: BASE_UNSIGNED,
    mutateHead: (dir) =>
      writeJson(join(dir, '.adlc', 'tickets.json'), {
        tickets: [{ id: 'T1', title: 'Fixture T1', triageClass: 'Trivial', triageCommit: 'abc123', rails: ['src/critical/**'] }],
      }),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /contract cannot change in \.adlc\/tickets\.json/);
});

test('rail-freeze gate rejects initial non-empty manifest evidence creation', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: [] }] },
    headConfig: BASE_UNSIGNED,
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '{"seq":1}\n'),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /manifest\.jsonl cannot be created with evidence/);
});

test('rail-freeze gate allows append-only manifest evidence', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: [] }] },
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '{"seq":1}\n'),
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '{"seq":1}\n{"seq":2}\n'),
  });
  assert.equal(result.status, 0);
});

test('rail-freeze gate rejects manifest rewrites', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: [] }] },
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '{"seq":1}\n'),
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '{"seq":0}\n{"seq":2}\n'),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /manifest\.jsonl must be append-only/);
});

for (const [path, renamedPath] of [
  ['.adlc/tickets.json', 'tickets-renamed.json'],
  ['.adlc/manifest.jsonl', 'manifest-renamed.jsonl'],
  ['CODEOWNERS', 'CODEOWNERS.renamed'],
  ['.github/workflows/adlc-rails-guard.yml', '.github/workflows/renamed.yml'],
]) {
  test(`rail-freeze gate rejects trust-root rename of ${path}`, () => {
    const result = runRailFreezeScenario({
      baseConfig: BASE_UNSIGNED,
      baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: [] }] },
      headConfig: BASE_UNSIGNED,
      mutateBase: (dir) => {
        if (path !== '.adlc/tickets.json') {
          mkdirSync(join(dir, dirname(path)), { recursive: true });
          writeFileSync(join(dir, path), 'base\n');
        }
      },
      mutateHead: (dir) => renameSync(join(dir, path), join(dir, renamedPath)),
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ADLC trust root changed, deleted, or renamed|exists at base but is absent at HEAD|base ticket store was removed or renamed at HEAD/);
  });

  test(`rail-freeze gate rejects trust-root deletion of ${path}`, () => {
    const result = runRailFreezeScenario({
      baseConfig: BASE_UNSIGNED,
      baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: [] }] },
      headConfig: BASE_UNSIGNED,
      mutateBase: (dir) => {
        if (path !== '.adlc/tickets.json') {
          mkdirSync(join(dir, dirname(path)), { recursive: true });
          writeFileSync(join(dir, path), 'base\n');
        }
      },
      mutateHead: (dir) => unlinkSync(join(dir, path)),
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ADLC trust root changed, deleted, or renamed|exists at base but is absent at HEAD|base ticket store was removed or renamed at HEAD/);
  });
}

// The trust-root set reaches enforcement even when ticket rails are also in play — the
// two sets are unioned, not one-or-the-other.
test('rail-freeze gate enforces trust roots alongside declared ticket rails', () => {
  const scenario = (mutateHead) => runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }] },
    headConfig: BASE_UNSIGNED,
    mutateBase: editAtHead('docs/CODEOWNERS', '* @adlc-admins\n'),
    mutateHead,
  });

  const trustRoot = scenario(editAtHead('docs/CODEOWNERS', '* @attacker\n'));
  assert.equal(trustRoot.status, 2);
  assert.match(trustRoot.stderr, /ADLC trust root changed, deleted, or renamed/);

  const ticketRail = scenario(editAtHead('src/critical/thing.txt'));
  assert.equal(ticketRail.status, 2);

  const unrelated = scenario(editAtHead('src/ordinary.txt'));
  assert.equal(unrelated.status, 0);
});

// ---- #283: the directory (sharded) ticket store backend ----
// A repo that ran `adlc ticket store migrate` has NO .adlc/tickets.json — its
// tickets live in per-shard files under .adlc/tickets/ with a .store.json
// manifest. Before this change the template read only tickets.json, so such a
// repo silently degraded to "protecting trust roots only" and STOPPED enforcing
// ticket rails in CI (fail-open). These pin the directory backend.

// Write a directory-backend store into `dir`: a .store.json manifest plus one
// shard file per ticket. Shard filenames mimic the real store (<id>--<hash>.json).
function writeDirStore(dir, tickets) {
  const ticketsDir = join(dir, '.adlc', 'tickets');
  mkdirSync(ticketsDir, { recursive: true });
  // The real @adlc/tickets manifest shape; the template validates this content.
  writeFileSync(join(ticketsDir, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
  for (const t of tickets) {
    writeFileSync(join(ticketsDir, ticketFilename(t.id)), JSON.stringify(t));
  }
}

// Run the rail-freeze gate against a directory-backend base and return its VERDICT.
//
// These assertions used to stub `adlc` on PATH and inspect the argv the gate passed to
// it. The shared gate spawns its sibling verdict bin by absolute path instead — version
// locked with the gate and not shimmable by a PATH entry — so the stub can no longer see
// it. Asserting the verdict is the better test anyway: "editing this path is denied" is
// the property that matters, and it holds regardless of how the rail set is plumbed.
function runDirBackend({ baseTickets, mutateHead }) {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    // no baseTickets → no legacy tickets.json; the directory store is seeded via mutateBase
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeDirStore(dir, baseTickets),
    mutateHead,
  });
  return { status: result.status, stderr: result.stderr };
}

// Edit a file at HEAD, creating parent directories. The gate judges the DIFF, so a
// scenario only exercises a rail if the PR actually touches a path under it.
function editAtHead(relPath, contents = 'changed\n') {
  return (dir) => {
    const target = join(dir, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
}

test('#283: directory-backend base enforces shard ticket rails (fail-open fix)', () => {
  const baseTickets = [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }];

  // Before the fix the gate read only tickets.json, so a directory-store repo silently
  // degraded to "trust roots only" and STOPPED enforcing ticket rails.
  const denied = runDirBackend({ baseTickets, mutateHead: editAtHead('src/critical/thing.txt') });
  assert.equal(denied.status, 2, denied.stderr);

  // The store manifest is itself a frozen trust root.
  const manifest = runDirBackend({
    baseTickets,
    mutateHead: editAtHead('.github/workflows/adlc-rails-guard.yml', 'name: tampered\n'),
  });
  assert.equal(manifest.status, 2, manifest.stderr);

  const allowed = runDirBackend({ baseTickets, mutateHead: editAtHead('src/ordinary.txt') });
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('#283: directory-backend completed ticket rails auto-expire; active rails stay frozen', () => {
  const baseTickets = [
    { id: 'T1', title: 'Fixture T1', rails: ['src/shipped/**'], completed: true },
    { id: 'T2', title: 'Fixture T2', rails: ['src/active/**'] },
  ];

  const expired = runDirBackend({ baseTickets, mutateHead: editAtHead('src/shipped/thing.txt') });
  assert.equal(expired.status, 0, `completed ticket rail must expire: ${expired.stderr}`);

  const stillFrozen = runDirBackend({ baseTickets, mutateHead: editAtHead('src/active/thing.txt') });
  assert.equal(stillFrozen.status, 2, `active ticket rail must stay frozen: ${stillFrozen.stderr}`);
});

test('#283: directory-backend allows adding a new shard while preserving existing tickets', () => {
  const baseTickets = [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }];
  const addShard = (dir) => writeFileSync(
    join(dir, '.adlc', 'tickets', ticketFilename('T2')),
    JSON.stringify({ id: 'T2', title: 'Fixture T2', rails: [] })
  );

  const added = runDirBackend({ baseTickets, mutateHead: addShard });
  assert.equal(added.status, 0, `adding a shard is an ordinary PR change: ${added.stderr}`);

  // The existing ticket's rail must STILL be frozen after a sibling shard is added.
  const stillFrozen = runDirBackend({
    baseTickets,
    mutateHead: (dir) => { addShard(dir); editAtHead('src/critical/thing.txt')(dir); },
  });
  assert.equal(stillFrozen.status, 2, stillFrozen.stderr);
});

test('#283: directory-backend rejects removing a base rail from a shard', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeDirStore(dir, [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }]),
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'tickets', ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 'Fixture T1', rails: [] })),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /contract cannot change in the \.adlc\/tickets\/ store/);
});

test('#283: directory-backend rejects removing an existing base shard', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeDirStore(dir, [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }]),
    mutateHead: (dir) => unlinkSync(join(dir, '.adlc', 'tickets', ticketFilename('T1'))),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot be removed from the \.adlc\/tickets\/ store/);
});

// BEHAVIOUR CHANGE (#140). The workflow template used to DENY every legacy→directory
// migration outright — not as a policy choice, but because its self-contained inline copy
// could not verify migration evidence, so it failed closed and routed migrations to the
// protected base. The shared gate CAN verify that evidence, so a migration is now judged
// on it: a migration carrying no valid, hash-chained manifest evidence still does not pass.
test('#283: a legacy→directory store migration without valid evidence does not pass', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }] }, // legacy base
    headConfig: BASE_UNSIGNED,
    mutateHead: (dir) => {
      unlinkSync(join(dir, '.adlc', 'tickets.json'));
      writeDirStore(dir, [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }]);
    },
  });
  assert.notEqual(result.status, 0, `a migration with no evidence must not pass: ${result.stdout}`);
  assert.equal(result.status, 1);
  // Fails on the migration path specifically (here: no migrated archive to bind evidence
  // to), not on some unrelated error that would also happen to be non-zero.
  assert.match(result.stderr, /migrat/i);
});

test('#283: an ambiguous base (both tickets.json AND a directory store) fails closed', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    baseTickets: { tickets: [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }] }, // legacy file at base
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeDirStore(dir, [{ id: 'T2', title: 'Fixture T2', rails: ['src/other/**'] }]), // AND a directory store
  });
  assert.equal(result.status, 1); // operational fail-closed, not a silent legacy-precedence
  assert.match(result.stderr, /AMBIGUOUS_STORE: both legacy and directory ticket stores exist/);
});

// The canonical store binds a shard's FILENAME to its ticket id (<slug>--<sha256(id)>),
// which makes dup-id shadowing structurally impossible rather than merely detected: a
// second shard claiming T1 either IS the T1 file (an ordinary contract change, denied
// below) or carries a filename that does not match its id (rejected outright).
test('#283: directory-backend rejects a second shard claiming an existing ticket id', () => {
  const sameFile = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeDirStore(dir, [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }]),
    // The canonical filename for T1 — so this is the SAME shard with its rails emptied.
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'tickets', ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 'Fixture T1', rails: [] })),
  });
  assert.equal(sameFile.status, 2);
  assert.match(sameFile.stderr, /contract cannot change in the \.adlc\/tickets\/ store/);

  const mismatchedName = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeDirStore(dir, [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }]),
    // A DIFFERENT filename carrying id T1 — the shadowing shape the old reader had to
    // detect by hand. The filename↔id binding refuses it before rails are ever computed.
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'tickets', ticketFilename('T2')), JSON.stringify({ id: 'T1', title: 'Fixture T1', rails: [] })),
  });
  assert.equal(mismatchedName.status, 1);
  assert.match(mismatchedName.stderr, /FILENAME_MISMATCH/);
});

test('#283: a malformed base shard fails closed', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => {
      writeDirStore(dir, []);
      writeFileSync(join(dir, '.adlc', 'tickets', ticketFilename('T1')), '{ not valid json');
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_JSON: invalid (shard|JSON in)/);
});

test('#283: editing .adlc/tickets/.store.json in a PR does not pass', () => {
  // An UNRECOGNIZED store manifest is refused by the loader before rails are computed —
  // fail closed (1), earlier and more specifically than the trust-root diff would.
  const unsupported = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeDirStore(dir, [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }]),
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'tickets', '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1, tampered: true })),
  });
  assert.equal(unsupported.status, 1);
  assert.notEqual(unsupported.status, 0);

  // And a STRUCTURALLY VALID rewrite — one the loader accepts — is still caught, by the
  // trust-root freeze. Without this case the assertion above would pass even if
  // .adlc/tickets/.store.json had quietly stopped being a trust root.
  const valid = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeDirStore(dir, [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }]),
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'tickets', '.store.json'), `${JSON.stringify({ format: 'adlc-ticket-directory', version: 1 })}\n`),
  });
  assert.equal(valid.status, 2);
  assert.match(valid.stderr, /ADLC trust root changed, deleted, or renamed/);
});

test('#283: a base directory store with an unsupported manifest version fails closed', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => {
      const ticketsDir = join(dir, '.adlc', 'tickets');
      mkdirSync(ticketsDir, { recursive: true });
      writeFileSync(join(ticketsDir, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 2 }));
      writeFileSync(join(ticketsDir, ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }));
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNSUPPORTED_STORE_FORMAT/);
});

// #283 P5 verification round: exercise the fail-closed enumeration defenses
// (non-blob/symlink/nested at base, symlink-skip + malformed at head) — this is
// the security-defense code, so a silent regression must break a test.

test('#283: a base shard that is a symlink (non-100644 blob) fails closed', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => {
      writeDirStore(dir, [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }]);
      // A symlink named like a shard: git records it as mode 120000, which the
      // base loop rejects instead of git-showing the link target.
      symlinkSync('../../elsewhere.json', join(dir, '.adlc', 'tickets', ticketFilename('T2')));
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNSAFE_GIT_MODE|UNRECOGNIZED_STORE_ENTRY|not a regular-file blob/);
});

test('#283: a stray non-.json entry in the base store dir fails closed', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => {
      writeDirStore(dir, [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }]);
      writeFileSync(join(dir, '.adlc', 'tickets', 'NOTES.txt'), 'not a shard\n');
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNRECOGNIZED_STORE_ENTRY: invalid ticket tree entry/);
});

test('#283: a malformed HEAD shard fails closed', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeDirStore(dir, [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }]),
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'tickets', ticketFilename('T2')), '{ broken'),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_JSON: invalid (shard|JSON in)/);
});

test('#283: a HEAD shard replaced by a symlink is never followed', () => {
  const result = runRailFreezeScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateBase: (dir) => writeDirStore(dir, [{ id: 'T1', title: 'Fixture T1', rails: ['src/critical/**'] }]),
    mutateHead: (dir) => {
      const shard = join(dir, '.adlc', 'tickets', ticketFilename('T1'));
      unlinkSync(shard);
      // If the store FOLLOWED this symlink it would read the decoy and see T1 with empty
      // rails — silently unfreezing src/critical/**. The canonical store refuses the
      // non-regular entry outright, so the decoy is never read.
      writeFileSync(join(dir, 'decoy.json'), JSON.stringify({ id: 'T1', title: 'Fixture T1', rails: [] }));
      symlinkSync('../../decoy.json', shard);
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNSAFE_GIT_MODE|UNRECOGNIZED_STORE_ENTRY|non-executable regular/);
});
