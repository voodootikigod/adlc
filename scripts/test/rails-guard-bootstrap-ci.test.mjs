// rails-guard-bootstrap-ci.test.mjs - regression tests for the bootstrap and
// signed-mode checks embedded in docs/ci/rails-guard.yml.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(ROOT, 'docs', 'ci', 'rails-guard.yml');
const HASH_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'rails-guard-workflow-hashes.json');

function extractNodeScript(marker) {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const markerAt = workflow.indexOf(marker);
  assert.notEqual(markerAt, -1, `${marker} marker exists`);
  const startToken = "node -e '\n";
  const start = workflow.indexOf(startToken, markerAt);
  assert.notEqual(start, -1, `${marker} node -e block exists`);
  const nodeLineStart = workflow.lastIndexOf('\n', start) + 1;
  const nodeIndent = workflow.slice(nodeLineStart, start);
  assert.match(nodeIndent, /^\s+$/, `${marker} node -e line has YAML indentation`);
  const codeStart = start + startToken.length;
  const lines = workflow.slice(codeStart).split('\n');
  const closeAt = lines.findIndex((line) => line === `${nodeIndent}'`);
  assert.notEqual(closeAt, -1, `${marker} node -e block terminates at matching indentation`);
  const scriptIndent = `${nodeIndent}  `;
  const script = lines
    .slice(0, closeAt)
    .map((line) => (line.startsWith(scriptIndent) ? line.slice(scriptIndent.length) : line))
    .join('\n');
  assert.ok(script.length > 500, `${marker} extraction produced a non-trivial script`);
  assert.doesNotThrow(() => new vm.Script(script), `${marker} extraction produced valid JavaScript`);
  return script;
}

function extractStepYaml(marker) {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const markerAt = workflow.indexOf(marker);
  assert.notEqual(markerAt, -1, `${marker} marker exists`);
  const nextStep = workflow.indexOf('\n      - name:', markerAt + marker.length);
  return workflow.slice(markerAt, nextStep === -1 ? undefined : nextStep);
}

function extractBootstrapScript() {
  const script = extractNodeScript('- name: Verify ADLC bootstrap acknowledgement');
  assert.match(script, /assertExistingSignerRolesExact\(trusted\.signers, head\.signers\)/);
  assert.match(script, /bootstrap mode: base has no \.adlc tree/);
  assert.match(script, /ADLC_SIGNED_RUNNER_POOL/);
  return script;
}

function extractRailFreezeScript() {
  const script = extractNodeScript('- name: Rail-freeze gate');
  assert.match(script, /adlc rails-guard/);
  assert.match(script, /bootstrap validation was handled by the previous step/);
  assert.match(script, /const trustRoots = \["\.adlc\/tickets\.json", "\.adlc\/config\.json", "\.adlc\/manifest\.jsonl", "\.github\/workflows\/adlc-rails-guard\.yml", "docs\/ci\/rails-guard\.yml", "scripts\/rails-guard-ci\.mjs", "scripts\/test\/rails-guard-workflow-hashes\.json"\]/);
  assert.match(script, /new Set\(\[...rails, ...trustRoots\]\)/);
  return script;
}

const BOOTSTRAP_SCRIPT = extractBootstrapScript();
const RAIL_FREEZE_SCRIPT = extractRailFreezeScript();

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

test('workflow inline script hashes match the checked-in fixture', () => {
  const fixture = JSON.parse(readFileSync(HASH_FIXTURE, 'utf8'));
  assert.equal(sha256(BOOTSTRAP_SCRIPT), fixture.bootstrap);
  assert.equal(sha256(RAIL_FREEZE_SCRIPT), fixture.railFreeze);
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

function runBootstrapScenario({ baseConfig, headConfig, env = {}, mutateBase, mutateHead }) {
  const dir = mkdtempSync(join(tmpdir(), 'rg-bootstrap-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'CODEOWNERS'), '.github/workflows/adlc-rails-guard.yml @adlc-admins\n');
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
    const result = spawnSync(process.execPath, ['-e', BOOTSTRAP_SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
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
    const result = spawnSync(process.execPath, ['-e', RAIL_FREEZE_SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BASE_REF: 'main', ...scenarioEnv },
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

test('bootstrap step requires CODEOWNERS protection for the deployed workflow', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: BASE_UNSIGNED,
    mutateHead: (dir) => writeFileSync(join(dir, '.github', 'CODEOWNERS'), '# missing workflow owner\n'),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing CODEOWNERS entry protecting \.github\/workflows\/adlc-rails-guard\.yml/);
});

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

test('new signer entries must declare role information', () => {
  const result = runBootstrapScenario({
    baseConfig: BASE_UNSIGNED,
    headConfig: {
      ...BASE_UNSIGNED,
      signers: {
        ...BASE_UNSIGNED.signers,
        bob: {},
      },
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new signer bob must declare a role or roles field/);
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
  assert.match(result.stderr, /signers\.alice\.role cannot change trusted value/);
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
  assert.match(result.stderr, /existing signer alice roles cannot change/);
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

test('rail-freeze bootstrap mode defers manifest validation to the bootstrap step', () => {
  const result = runRailFreezeScenario({
    baseConfig: null,
    headConfig: BASE_UNSIGNED,
    mutateHead: (dir) => writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '{"prepopulated":true}\n'),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /bootstrap validation was handled by the previous step/);
});

test('rail-freeze gate fails closed when base .adlc exists without config acknowledgement', () => {
  const result = runRailFreezeScenario({
    baseConfig: false,
    baseTickets: { tickets: [] },
    headConfig: BASE_UNSIGNED,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /base \.adlc\/config\.json is absent/);
});

test('rail-freeze gate protects trust roots when base tickets declare no rails', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rg-adlc-bin-'));
  try {
    const binDir = join(tmp, 'bin');
    const capturePath = join(tmp, 'argv.json');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'adlc'),
      [
        '#!/usr/bin/env node',
        "const { writeFileSync } = require('fs');",
        'writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));',
        'process.exit(0);',
        '',
      ].join('\n'),
      { mode: 0o700 }
    );
    const result = runRailFreezeScenario({
      baseConfig: BASE_UNSIGNED,
      baseTickets: { tickets: [{ id: 'T1', rails: [] }] },
      headConfig: BASE_UNSIGNED,
      env: {
        PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
        CAPTURE_PATH: capturePath,
      },
    });
    assert.equal(result.status, 0);
    const argv = JSON.parse(readFileSync(capturePath, 'utf8'));
    assert.deepEqual(argv, [
      'rails-guard',
      '--base',
      'origin/main',
      '--rails',
      '.adlc/tickets.json',
      '--rails',
      '.adlc/config.json',
      '--rails',
      '.adlc/manifest.jsonl',
      '--rails',
      '.github/workflows/adlc-rails-guard.yml',
      '--rails',
      'docs/ci/rails-guard.yml',
      '--rails',
      'scripts/rails-guard-ci.mjs',
      '--rails',
      'scripts/test/rails-guard-workflow-hashes.json',
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('rail-freeze gate passes trust-root rail to adlc rails-guard', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rg-adlc-bin-'));
  try {
    const binDir = join(tmp, 'bin');
    const capturePath = join(tmp, 'argv.json');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'adlc'),
      [
        '#!/usr/bin/env node',
        "const { writeFileSync } = require('fs');",
        'writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));',
        'process.exit(0);',
        '',
      ].join('\n'),
      { mode: 0o700 }
    );
    const result = runRailFreezeScenario({
      baseConfig: BASE_UNSIGNED,
      baseTickets: { tickets: [{ id: 'T1', rails: ['src/critical/**'] }] },
      headConfig: BASE_UNSIGNED,
      env: {
        PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
        CAPTURE_PATH: capturePath,
      },
    });
    assert.equal(result.status, 0);
    const argv = JSON.parse(readFileSync(capturePath, 'utf8'));
    assert.deepEqual(argv, [
      'rails-guard',
      '--base',
      'origin/main',
      '--rails',
      'src/critical/**',
      '--rails',
      '.adlc/tickets.json',
      '--rails',
      '.adlc/config.json',
      '--rails',
      '.adlc/manifest.jsonl',
      '--rails',
      '.github/workflows/adlc-rails-guard.yml',
      '--rails',
      'docs/ci/rails-guard.yml',
      '--rails',
      'scripts/rails-guard-ci.mjs',
      '--rails',
      'scripts/test/rails-guard-workflow-hashes.json',
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
