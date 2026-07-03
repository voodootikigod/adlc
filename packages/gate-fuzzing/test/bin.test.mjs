/**
 * bin.test.mjs — CLI integration tests for --provider / --providers
 * (issue #63). Spawns the real binary as a subprocess; no network calls or
 * real API keys required — validation errors and --prompt-only both short-
 * circuit before any provider is actually contacted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const BIN = resolve(new URL('../bin/gate-fuzzing.mjs', import.meta.url).pathname);

function makeRepoWithSuite() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fuzzing-bin-test-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(
    join(dir, '.adlc/gate-suite.json'),
    JSON.stringify({ gates: [{ name: 'test-gate', claims: ['no regressions'], surface: ['src/**'] }] })
  );
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    // Strip any provider API keys from the ambient environment so these
    // tests are deterministic regardless of the machine they run on.
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      ADLC_AGY: '',
      ADLC_PROVIDER: '',
      ...env,
    },
  });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}

test('--provider and --providers are mutually exclusive', () => {
  const dir = makeRepoWithSuite();
  try {
    const { code, stderr } = runCli(['--provider', 'anthropic', '--providers', 'anthropic,openai', '--prompt-only'], { cwd: dir });
    assert.equal(code, 1);
    assert.match(stderr, /mutually exclusive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--provider rejects an unknown provider name', () => {
  const dir = makeRepoWithSuite();
  try {
    const { code, stderr } = runCli(['--provider', 'not-a-real-provider', '--prompt-only'], { cwd: dir });
    assert.equal(code, 1);
    assert.match(stderr, /--provider must be one of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--providers rejects an unknown provider name in the list', () => {
  const dir = makeRepoWithSuite();
  try {
    const { code, stderr } = runCli(['--providers', 'anthropic,bogus', '--prompt-only'], { cwd: dir });
    assert.equal(code, 1);
    assert.match(stderr, /unknown provider name/);
    assert.match(stderr, /bogus/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--providers rejects duplicate provider names', () => {
  const dir = makeRepoWithSuite();
  try {
    const { code, stderr } = runCli(['--providers', 'anthropic,anthropic', '--prompt-only'], { cwd: dir });
    assert.equal(code, 1);
    assert.match(stderr, /DISTINCT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--providers overrides --n for --prompt-only fan width (prompt count = number of providers)', () => {
  const dir = makeRepoWithSuite();
  try {
    const { code, stdout } = runCli(['--n', '6', '--providers', 'anthropic,openai', '--prompt-only'], { cwd: dir });
    assert.equal(code, 0);
    const promptCount = (stdout.match(/Fan instance \d+\/2/g) ?? []).length;
    assert.equal(promptCount, 2, 'fan width should be 2 (number of providers), not --n=6');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without --provider/--providers, --prompt-only fan width still follows --n (unchanged default)', () => {
  const dir = makeRepoWithSuite();
  try {
    const { code, stdout } = runCli(['--n', '3', '--prompt-only'], { cwd: dir });
    assert.equal(code, 0);
    const promptCount = (stdout.match(/Fan instance \d+\/3/g) ?? []).length;
    assert.equal(promptCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--providers with no API keys configured fails closed with a clear operational error (not a network call)', () => {
  const dir = makeRepoWithSuite();
  try {
    const { code, stderr } = runCli(['--providers', 'anthropic,openai', '--unsafe-no-sandbox'], { cwd: dir });
    assert.equal(code, 1);
    assert.match(stderr, /not available \(missing API key\)/);
    assert.match(stderr, /anthropic/);
    assert.match(stderr, /openai/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--provider naming an unavailable provider fails closed with a provider-specific error', () => {
  const dir = makeRepoWithSuite();
  try {
    const { code, stderr } = runCli(['--provider', 'anthropic', '--unsafe-no-sandbox'], { cwd: dir });
    assert.equal(code, 1);
    assert.match(stderr, /--provider anthropic is not available/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
