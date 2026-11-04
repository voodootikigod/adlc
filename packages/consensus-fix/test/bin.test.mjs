/**
 * bin.test.mjs — CLI integration tests for --provider / --providers
 * (issue #63). Spawns the real binary as a subprocess; no network calls or
 * real API keys required — validation errors and --prompt-only both short-
 * circuit before any provider is actually contacted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';

const BIN = resolve(new URL('../bin/consensus-fix.mjs', import.meta.url).pathname);

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

test('--prompt-only does not dump a large file whole into the printed prompt', (t) => {
  const dir = tmp(t, 'consensus-fix-bin-test-');
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
});

test('--prompt-only requests the hunk-based output schema, not full-file content', (t) => {
  const dir = tmp(t, 'consensus-fix-bin-test-');
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
});

test('--provider and --providers are mutually exclusive', (t) => {
  const dir = tmp(t, 'consensus-fix-bin-test-');
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
});

test('--provider rejects an unknown provider name', (t) => {
  const dir = tmp(t, 'consensus-fix-bin-test-');
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
});

test('--providers rejects an unknown provider name in the list', (t) => {
  const dir = tmp(t, 'consensus-fix-bin-test-');
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
});

test('--providers rejects duplicate provider names', (t) => {
  const dir = tmp(t, 'consensus-fix-bin-test-');
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
});

test('--providers overrides --n for --prompt-only prompt count (fan width = number of providers)', (t) => {
  const dir = tmp(t, 'consensus-fix-bin-test-');
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
});

test('without --provider/--providers, --prompt-only prompt count still follows --n (unchanged default)', (t) => {
  const dir = tmp(t, 'consensus-fix-bin-test-');
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
});

test('--providers with no API keys configured fails closed with a clear operational error (not a network call)', (t) => {
  const dir = tmp(t, 'consensus-fix-bin-test-');
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
});

test('--provider naming an unavailable provider fails closed with a provider-specific error', (t) => {
  const dir = tmp(t, 'consensus-fix-bin-test-');
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
});

test('outside a git repo without --allow-dirty, CLI prints a loud dirty-tree guard skipped warning on stderr (#601)', (t) => {
  const dir = tmp(t, 'consensus-fix-nogit-');
  const f = join(dir, 'a.mjs');
  writeFileSync(f, 'export const x = 1;\n');
  const { code, stderr } = runCli([
    '--test-cmd', 'exit 1',
    '--files', f,
  ], { cwd: dir });
  assert.equal(code, 1);
  assert.match(stderr, /WARNING: dirty-tree guard skipped/);
  assert.match(stderr, /no LLM provider configured/);
});

test('with --allow-dirty outside a git repo, CLI does not emit the dirty-tree guard skipped warning (#601)', (t) => {
  const dir = tmp(t, 'consensus-fix-allow-dirty-');
  const f = join(dir, 'a.mjs');
  writeFileSync(f, 'export const x = 1;\n');
  const { code, stderr } = runCli([
    '--test-cmd', 'exit 1',
    '--files', f,
    '--allow-dirty',
  ], { cwd: dir });
  assert.equal(code, 1);
  assert.doesNotMatch(stderr, /dirty-tree guard skipped/);
});

test('CLI --json output surfaces summary.dirtyCheckSkipped: true outside a git repo and false with --allow-dirty (#601)', (t) => {
  const dir = tmp(t, 'consensus-fix-json-dirty-skip-');
  const f = join(dir, 'target.mjs');
  writeFileSync(f, 'export const val = 1;\n');
  const preload = join(dir, 'mock-llm.mjs');
  writeFileSync(preload, `
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        changes: [{ file: ${JSON.stringify(f)},
          hunks: [{ startLine: 1, endLine: 1, replacement: 'export const val = 2;' }] }]
      }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  `);

  const testCmd = `grep -q 'val = 2' '${f}'`;

  const skippedRun = spawnSync(
    process.execPath,
    ['--import', preload, BIN, '--test-cmd', testCmd, '--files', f, '--n', '1', '--json'],
    {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, OPENAI_API_KEY: 'mock-key', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', ADLC_AGY: '', ADLC_PROVIDER: '' },
    },
  );
  assert.equal(skippedRun.status, 0, `stderr: ${skippedRun.stderr}`);
  assert.match(skippedRun.stderr, /WARNING: dirty-tree guard skipped/);
  const skippedParsed = JSON.parse(skippedRun.stdout);
  assert.equal(skippedParsed.summary.dirtyCheckSkipped, true);

  const allowDirtyRun = spawnSync(
    process.execPath,
    ['--import', preload, BIN, '--test-cmd', testCmd, '--files', f, '--n', '1', '--allow-dirty', '--json'],
    {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, OPENAI_API_KEY: 'mock-key', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', ADLC_AGY: '', ADLC_PROVIDER: '' },
    },
  );
  assert.equal(allowDirtyRun.status, 0, `stderr: ${allowDirtyRun.stderr}`);
  assert.doesNotMatch(allowDirtyRun.stderr, /dirty-tree guard skipped/);
  const allowDirtyParsed = JSON.parse(allowDirtyRun.stdout);
  assert.equal(allowDirtyParsed.summary.dirtyCheckSkipped, false);
});

test('--require-rails exits 1 via opError when --rails is omitted or empty (#603)', (t) => {
  const dir = tmp(t, 'consensus-fix-req-rails-');
  const f = join(dir, 'a.mjs');
  writeFileSync(f, 'export const x = 1;\n');
  for (const extra of [['--require-rails'], ['--require-rails', '--rails', '']]) {
    const { code, stderr } = runCli([
      '--test-cmd', 'exit 1',
      '--files', f,
      ...extra,
      '--prompt-only',
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /--require-rails requires a non-empty --rails <cmd> regression gate/);
  }
});

test('--require-rails succeeds when --rails is provided (#603)', (t) => {
  const dir = tmp(t, 'consensus-fix-req-rails-ok-');
  const f = join(dir, 'a.mjs');
  writeFileSync(f, 'export const x = 1;\n');
  const { code, stdout } = runCli([
    '--test-cmd', 'exit 1',
    '--files', f,
    '--require-rails',
    '--rails', 'npm test',
    '--prompt-only',
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /<test output will appear here>/);
});
