// packages/gate-fuzzing/test/empty-candidates.test.mjs
// Issue #640: gate-fuzzing unusable/empty candidates handling.
// Confirms that unusable adversary output (refusals, malformed JSON, schema invalid)
// marks rounds inconclusive rather than advancing dryStreak,
// and computeVerdict refuses clean (exits non-zero / exit 2) on zero classified candidates
// unless --allow-empty is supplied.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { runLoop } from '../lib/loop.mjs';
import { computeVerdict } from '../lib/verdict.mjs';
import { cannedCandidate, defeatableGateDescriptor } from '../lib/controls.mjs';

const BASELINE = { dir: '/fake/baseline' };
const CLONE_DIR = '/fake/clone';
const SUITE = [defeatableGateDescriptor()];
const BIN = resolve(new URL('../bin/gate-fuzzing.mjs', import.meta.url).pathname);

function makeRefusalFan() {
  return async () => [{ ok: true, value: 'I cannot help with this request.' }];
}

function makeMalformedFan() {
  return async () => [{ ok: true, value: '```json\n{ not valid json\n```' }];
}

function makeSchemaInvalidFan() {
  return async () => [{
    ok: true,
    value: JSON.stringify({
      target: 'defeatable-gate',
      // missing claimKind, diff, witnessProposal
    }),
  }];
}

function makeDisallowedCmdFan() {
  return async () => [{
    ok: true,
    value: JSON.stringify({
      target: 'defeatable-gate',
      claimKind: 'freeze-integrity',
      diff: 'diff --git a/a b/a\n+x',
      witnessProposal: { cmd: 'curl', args: ['http://malicious.example'] },
      setup: [],
    }),
  }];
}

function makeOutOfScopeClassify() {
  return () => ({ result: 'out-of-scope', reason: 'off surface' });
}

// ─── AC1: unusable model output marks rounds inconclusive ─────────────────────

test('AC1: model refusal output does not advance dryStreak and marks round inconclusive', async () => {
  const result = await runLoop(SUITE, BASELINE, {
    fanFn: makeRefusalFan(),
    classifyFn: makeOutOfScopeClassify(),
    maxRounds: 3,
    dryRounds: 3,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  // Must NOT stop by 'dry' streak, because 0 candidates were ever classified
  assert.notEqual(result.stoppedBy, 'dry', 'unusable output must not count as dry rounds');
  assert.equal(result.exhaustive, false, 'run with zero classified candidates cannot be exhaustive');
  assert.equal(result.inconclusiveRounds, 3, 'all 3 refusal rounds must be marked inconclusive');
  assert.equal(result.candidatesGenerated ?? result.candidatesParsed ?? 0, 0, 'candidatesGenerated must be 0');
});

test('AC1: malformed and schema-invalid output does not advance dryStreak', async () => {
  const result = await runLoop(SUITE, BASELINE, {
    fanFn: makeSchemaInvalidFan(),
    classifyFn: makeOutOfScopeClassify(),
    maxRounds: 3,
    dryRounds: 3,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  assert.notEqual(result.stoppedBy, 'dry');
  assert.equal(result.exhaustive, false);
  assert.equal(result.inconclusiveRounds, 3);
  assert.equal(result.candidatesGenerated ?? result.candidatesParsed ?? 0, 0);
});

test('AC1 / Normative 3: candidate rejections are tracked by reason and candidatesGenerated reflects usable candidates', async () => {
  let callCount = 0;
  const mixedFan = async () => {
    callCount++;
    if (callCount === 1) {
      return [{ ok: true, value: 'refusal' }]; // malformed / unparseable
    }
    if (callCount === 2) {
      return makeDisallowedCmdFan()(); // invalid:cmd
    }
    // Round 3: valid candidate
    const c = cannedCandidate();
    return [{ ok: true, value: JSON.stringify({ ...c, diff: 'diff --git a/off b/off\n+noop' }) }];
  };

  const result = await runLoop(SUITE, BASELINE, {
    fanFn: mixedFan,
    classifyFn: makeOutOfScopeClassify(),
    maxRounds: 3,
    dryRounds: 5,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  assert.equal(result.inconclusiveRounds, 2, 'first 2 rounds had 0 valid candidates');
  assert.equal(result.candidatesGenerated ?? result.candidatesParsed ?? 0, 1, 'only 1 usable candidate generated');
  assert.ok(result.candidatesRejected, 'candidatesRejected map must exist');
  assert.equal(result.candidatesRejected['invalid:cmd'], 1, 'must record exactly 1 invalid:cmd rejection');
  assert.equal(result.candidatesRejected['invalid:malformed'], 1, 'must record exactly 1 invalid:malformed rejection');
});

// ─── AC2: zero classified candidates produces inconclusive verdict and non-zero exit ─

test('AC2: computeVerdict refuses clean and returns exit 2 on 0 classified candidates', () => {
  const result = computeVerdict({
    defeats: [],
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 3,
    candidatesClassified: 0,
    strictBudget: false,
    failOnBehavioral: false,
    independenceConfigured: true,
  });

  assert.equal(result.summary, 'inconclusive');
  assert.equal(result.inconclusive, true);
  assert.equal(result.exitCode, 2, 'must exit non-zero (exit 2) when 0 candidates were classified');
  assert.equal(result.contractDefeats, 0);
  assert.equal(result.behavioralDefeats, 0);
});

test('AC1: round with failRate > maxFailRate is marked inconclusive even if some candidates were valid', async () => {
  const c = cannedCandidate();
  const fanFn = async () => [
    { ok: true, value: 'refusal 1' },
    { ok: true, value: 'refusal 2' },
    { ok: true, value: 'refusal 3' },
    { ok: true, value: JSON.stringify({ ...c, diff: 'diff --git a/off b/off\n+noop' }) },
  ];

  const result = await runLoop(SUITE, BASELINE, {
    fanFn,
    classifyFn: makeOutOfScopeClassify(),
    maxRounds: 1,
    dryRounds: 3,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 4,
  });

  assert.equal(result.inconclusiveRounds, 1, 'round above fail rate must be marked inconclusive');
  assert.notEqual(result.stoppedBy, 'dry');
});

test('AC2: computeVerdict with allowEmpty: true returns exitCode 0 on 0 classified candidates', () => {
  const result = computeVerdict({
    defeats: [],
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 3,
    candidatesClassified: 0,
    allowEmpty: true,
    strictBudget: false,
    failOnBehavioral: false,
    independenceConfigured: true,
  });

  assert.equal(result.summary, 'inconclusive');
  assert.equal(result.inconclusive, true);
  assert.equal(result.exitCode, 0, '--allow-empty allows exit 0');
});

test('AC2: computeVerdict still returns clean when candidatesClassified > 0 and no defeats', () => {
  const result = computeVerdict({
    defeats: [],
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 3,
    candidatesClassified: 3,
    strictBudget: false,
    failOnBehavioral: false,
    independenceConfigured: true,
  });

  assert.equal(result.summary, 'clean');
  assert.equal(result.inconclusive, false);
  assert.equal(result.exitCode, 0);
});

// ─── CLI documentation and flags ──────────────────────────────────────────────

test('--help documents --allow-empty and exit code 2 on zero candidates', () => {
  const { stdout, status } = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(status, 0);
  assert.match(stdout, /--allow-empty\s+Allow run to exit 0 when zero candidates are evaluated/);
  assert.match(stdout, /2\s+A gate was defeated, or zero candidates were evaluated and --allow-empty not set/);
});

test('CLI without --allow-empty warns on stderr and exits 2 when 0 candidates generated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fuzzing-empty-candidates-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'suite.json'), JSON.stringify({
      gates: [{ name: 'test-gate', claims: ['freeze-integrity'], surface: ['src/**'] }],
    }));
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

    const result = spawnSync(process.execPath, [
      BIN,
      '--suite', 'suite.json',
      '--max-rounds', '1',
      '--dry-rounds', '1',
      '--unsafe-no-sandbox',
    ], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADLC_PROVIDER: 'agy',
        ADLC_AGY: '/bin/cat',
      },
    });

    assert.equal(result.status, 2, 'must exit 2 by default on 0 candidates evaluated');
    assert.match(result.stderr, /WARNING: candidate generation returned 0 valid candidates \(empty mutants pool\)/);
    assert.match(result.stdout, /candidates: 0 usable/);
    assert.match(result.stdout, /rejections: fan:error:6/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI with --json surfaces candidatesGenerated and candidatesRejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fuzzing-json-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'suite.json'), JSON.stringify({
      gates: [{ name: 'test-gate', claims: ['freeze-integrity'], surface: ['src/**'] }],
    }));
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

    const result = spawnSync(process.execPath, [
      BIN,
      '--suite', 'suite.json',
      '--max-rounds', '1',
      '--dry-rounds', '1',
      '--unsafe-no-sandbox',
      '--json',
    ], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADLC_PROVIDER: 'agy',
        ADLC_AGY: '/bin/cat',
      },
    });

    assert.equal(result.status, 2, 'must exit 2 when 0 candidates evaluated');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.candidatesGenerated, 0);
    assert.deepEqual(parsed.candidatesRejected, { 'fan:error': 6 });
    assert.equal(parsed.summary, 'inconclusive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI with --allow-empty warns on stderr and exits 0 when 0 candidates generated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fuzzing-allow-empty-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'suite.json'), JSON.stringify({
      gates: [{ name: 'test-gate', claims: ['freeze-integrity'], surface: ['src/**'] }],
    }));
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

    const result = spawnSync(process.execPath, [
      BIN,
      '--suite', 'suite.json',
      '--max-rounds', '1',
      '--dry-rounds', '1',
      '--unsafe-no-sandbox',
      '--allow-empty',
    ], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADLC_PROVIDER: 'agy',
        ADLC_AGY: '/bin/cat',
      },
    });

    assert.equal(result.status, 0, `must exit 0 with --allow-empty (stderr: ${result.stderr}, stdout: ${result.stdout})`);
    assert.match(result.stderr, /WARNING: candidate generation returned 0 valid candidates \(empty mutants pool\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateCandidate guards against null and non-object inputs', async () => {
  const { validateCandidate } = await import('../lib/candidate.mjs');
  assert.deepEqual(validateCandidate(null), { valid: false, reason: 'invalid:malformed' });
  assert.deepEqual(validateCandidate(undefined), { valid: false, reason: 'invalid:malformed' });
  assert.deepEqual(validateCandidate('string'), { valid: false, reason: 'invalid:malformed' });
  assert.deepEqual(validateCandidate(123), { valid: false, reason: 'invalid:malformed' });
});

test('runLoop: round where all candidates fail provisioning is inconclusive and does not advance dryStreak', async () => {
  const c = cannedCandidate();
  const fanFn = async () => [
    { ok: true, value: JSON.stringify(c) },
  ];

  const result = await runLoop(SUITE, BASELINE, {
    fanFn,
    classifyFn: async () => ({ result: 'PASS' }),
    provisionFn: async () => ({ error: 'git apply failed' }),
    maxRounds: 2,
    dryRounds: 1,
    tokenBudget: 1_000_000,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  assert.equal(result.inconclusiveRounds, 2, 'all-provisioning-failed rounds must be marked inconclusive');
  assert.equal(result.candidatesEvaluated, 0, 'zero candidates were successfully evaluated');
  assert.equal(result.exhaustive, false, 'exhaustive must be false when zero candidates were evaluated');
  assert.equal(result.stoppedBy, 'maxRounds', 'must not stop by dry when all candidates failed provisioning');
});
