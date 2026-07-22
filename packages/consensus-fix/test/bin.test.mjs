/**
 * bin.test.mjs — CLI integration tests for --provider / --providers
 * (issue #63). Spawns the real binary as a subprocess; no network calls or
 * real API keys required — validation errors and --prompt-only both short-
 * circuit before any provider is actually contacted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve(new URL('../bin/consensus-fix.mjs', import.meta.url).pathname);

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'consensus-fix-bin-test-'));
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

// ─── --prompt-only emits the compact (windowed/capped) prompt (issue #279) ────

test('--prompt-only does not dump a large file whole into the printed prompt', () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'big.mjs');
    const content = Array.from({ length: 600 }, (_, i) => `function helper${i}() { return ${i}; }`).join('\n');
    writeFileSync(f, content);

    const { code, stdout } = runCli([
      '--test-cmd', 'exit 1',
      '--files', f,
      '--n', '1',
      '--prompt-only',
    ], { cwd: dir });

    assert.equal(code, 0);
    // The whole 600-line file must not appear verbatim in the printed prompt
    // — --prompt-only has no real test output yet (a placeholder), so every
    // file falls through to the length-capped fallback rather than being
    // embedded whole.
    assert.ok(!stdout.includes(content), 'the full file content must not appear in the prompt');
    assert.ok(stdout.length < content.length, 'the whole prompt should be smaller than the raw file it is about');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--prompt-only requests the hunk-based output schema, not full-file content', () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'a.mjs');
    writeFileSync(f, 'export const x = 1;\n');
    const { code, stdout } = runCli([
      '--test-cmd', 'exit 1',
      '--files', f,
      '--n', '1',
      '--prompt-only',
    ], { cwd: dir });

    assert.equal(code, 0);
    assert.ok(stdout.includes('"hunks"'));
    assert.ok(stdout.includes('startLine'));
    assert.ok(!stdout.includes('"content"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--provider and --providers are mutually exclusive', () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'a.mjs');
    writeFileSync(f, 'export const x = 1;\n');
    const { code, stderr } = runCli([
      '--test-cmd', 'exit 1',
      '--files', f,
      '--provider', 'anthropic',
      '--providers', 'anthropic,openai',
      '--prompt-only',
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /mutually exclusive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--provider rejects an unknown provider name', () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'a.mjs');
    writeFileSync(f, 'export const x = 1;\n');
    const { code, stderr } = runCli([
      '--test-cmd', 'exit 1',
      '--files', f,
      '--provider', 'not-a-real-provider',
      '--prompt-only',
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /--provider must be one of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--providers rejects an unknown provider name in the list', () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'a.mjs');
    writeFileSync(f, 'export const x = 1;\n');
    const { code, stderr } = runCli([
      '--test-cmd', 'exit 1',
      '--files', f,
      '--providers', 'anthropic,bogus',
      '--prompt-only',
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /unknown provider name/);
    assert.match(stderr, /bogus/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--providers rejects duplicate provider names', () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'a.mjs');
    writeFileSync(f, 'export const x = 1;\n');
    const { code, stderr } = runCli([
      '--test-cmd', 'exit 1',
      '--files', f,
      '--providers', 'anthropic,anthropic',
      '--prompt-only',
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /DISTINCT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--providers overrides --n for --prompt-only prompt count (fan width = number of providers)', () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'a.mjs');
    writeFileSync(f, 'export const x = 1;\n');
    const { code, stdout } = runCli([
      '--test-cmd', 'exit 1',
      '--files', f,
      '--n', '5', // should be ignored/overridden by --providers
      '--providers', 'anthropic,openai',
      '--prompt-only',
    ]);
    assert.equal(code, 0);
    const promptCount = (stdout.match(/--- prompt \d+ of 2 ---/g) ?? []).length;
    assert.equal(promptCount, 2, 'fan width should be 2 (number of providers), not --n=5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without --provider/--providers, --prompt-only prompt count still follows --n (unchanged default)', () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'a.mjs');
    writeFileSync(f, 'export const x = 1;\n');
    const { code, stdout } = runCli([
      '--test-cmd', 'exit 1',
      '--files', f,
      '--n', '4',
      '--prompt-only',
    ]);
    assert.equal(code, 0);
    const promptCount = (stdout.match(/--- prompt \d+ of 4 ---/g) ?? []).length;
    assert.equal(promptCount, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--providers with no API keys configured fails closed with a clear operational error (not a network call)', () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'a.mjs');
    writeFileSync(f, 'export const x = 1;\n');
    const { code, stderr } = runCli([
      '--test-cmd', 'exit 1',
      '--files', f,
      '--allow-dirty',
      '--providers', 'anthropic,openai',
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /not available \(missing API key\)/);
    assert.match(stderr, /anthropic/);
    assert.match(stderr, /openai/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--provider naming an unavailable provider fails closed with a provider-specific error', () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'a.mjs');
    writeFileSync(f, 'export const x = 1;\n');
    const { code, stderr } = runCli([
      '--test-cmd', 'exit 1',
      '--files', f,
      '--allow-dirty',
      '--provider', 'anthropic',
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /--provider anthropic is not available/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
