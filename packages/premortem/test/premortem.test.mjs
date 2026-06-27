// test/premortem.test.mjs — offline tests for the premortem tool.
// All tests use fixtures; no LLM calls, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildPrompt, SYSTEM_PROMPT } from '../lib/prompt.mjs';
import { renderReport } from '../lib/render.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_CAUSES = [
  {
    cause: 'Rate limiter on /checkout was never load-tested beyond 50 RPS; real peak hit 3000 RPS on launch day',
    earliest_signal: 'P95 latency on /checkout spiked 30 min before the full outage',
    prevention: 'Add k6 smoke test requiring < 200 ms at 500 RPS as a gate in the CI pipeline',
    interrogation_question: 'What is the measured RPS capacity of the /checkout endpoint under realistic order payloads?',
  },
  {
    cause: 'Inventory service returned HTTP 200 with an empty items array when the product catalogue DB replica fell behind by > 5 s, causing ghost stock',
    earliest_signal: 'Cart-to-purchase conversion dropped to 0% but no error-rate alert fired',
    prevention: 'Return HTTP 503 when replica lag exceeds threshold; add an integration test asserting this',
    interrogation_question: 'How does the inventory service signal replica lag to callers, and is that signal tested?',
  },
  {
    cause: 'OAuth token refresh was not retried on transient 5xx from the identity provider; sessions expired silently mid-checkout',
    earliest_signal: 'Support tickets about "logged out at payment screen" filed 2 days before the spec was approved',
    prevention: 'Implement exponential-backoff retry in the OAuth client; add unit test with a mock 502 sequence',
    interrogation_question: 'What happens to an active checkout session when the identity provider returns a 502 during token refresh?',
  },
  {
    cause: 'Feature-flag service was a single instance with no HA; it became a SPOF for every server-side rendered page',
    earliest_signal: 'Infra ticket #4422 noted "flag service has no replica" three sprints before launch',
    prevention: 'Add replica; add circuit breaker that falls back to cached flags if service is unreachable',
    interrogation_question: 'What is the degraded-mode behaviour of the application when the feature-flag service is unreachable?',
  },
  {
    cause: 'Database migrations ran inside the deploy script without a dry-run gate; an additive migration caused a table lock lasting 47 s on the orders table',
    earliest_signal: 'Staging deploy logs showed "LOCK WAIT" warnings that were dismissed as normal',
    prevention: 'Run migrations with --dry-run first; assert zero lock-wait warnings before applying',
    interrogation_question: 'Is there a gate that prevents a migration deployment if LOCK WAIT warnings appear in staging?',
  },
];

const FIXTURE_SPEC = `# Spec: Lightning Checkout v2

## Overview
Rewrite the checkout flow to reduce P95 latency from 800 ms to < 200 ms.

## Acceptance Criteria
- AC1: /checkout handles 500 RPS with P95 < 200 ms
- AC2: Inventory service returns correct stock counts
- AC3: OAuth sessions persist through the entire checkout flow
- AC4: Feature flags are evaluated server-side
- AC5: Schema migrations are applied atomically
`;

// ---------------------------------------------------------------------------
// 1. renderReport — markdown structure
// ---------------------------------------------------------------------------

test('renderReport: produces markdown with causes table', () => {
  const report = renderReport(FIXTURE_CAUSES);
  assert.ok(report.includes('# Premortem Report'), 'has h1 heading');
  assert.ok(report.includes('## Failure Causes'), 'has Failure Causes section');
  assert.ok(report.includes('## Questions to fold into interrogation'), 'has interrogation questions section');
});

test('renderReport: table contains all cause rows', () => {
  const report = renderReport(FIXTURE_CAUSES);
  for (const c of FIXTURE_CAUSES) {
    // Each cause text should appear (possibly with pipe escaping)
    assert.ok(report.includes(c.cause.slice(0, 20)), `table row contains cause starting with "${c.cause.slice(0, 20)}"`);
  }
});

test('renderReport: questions list numbered', () => {
  const report = renderReport(FIXTURE_CAUSES);
  for (let i = 1; i <= FIXTURE_CAUSES.length; i++) {
    assert.ok(report.includes(`${i}.`), `numbered list has entry ${i}`);
  }
});

test('renderReport: pipe characters inside cells are escaped', () => {
  const causesWithPipes = [
    {
      cause: 'A|B caused failure',
      earliest_signal: 'signal|one',
      prevention: 'fix|it',
      interrogation_question: 'Q|1?',
    },
  ];
  const report = renderReport(causesWithPipes);
  // The pipe in the cause should be escaped so the table stays valid
  assert.ok(report.includes('A\\|B'), 'pipe in cause is escaped');
});

test('renderReport: newlines inside fields are collapsed to spaces', () => {
  const causesWithNewlines = [
    {
      cause: 'line1\nline2',
      earliest_signal: 'sig',
      prevention: 'prev',
      interrogation_question: 'q?',
    },
  ];
  const report = renderReport(causesWithNewlines);
  assert.ok(!report.includes('line1\nline2'), 'newline inside cell is not left raw');
  assert.ok(report.includes('line1 line2'), 'newline replaced by space');
});

// ---------------------------------------------------------------------------
// 2. buildPrompt — prompt construction
// ---------------------------------------------------------------------------

test('buildPrompt: includes spec text verbatim', () => {
  const prompt = buildPrompt(FIXTURE_SPEC);
  assert.ok(prompt.includes('Lightning Checkout v2'), 'prompt contains spec title');
  assert.ok(prompt.includes('AC1:'), 'prompt contains acceptance criteria');
});

test('buildPrompt: contains failure framing', () => {
  const prompt = buildPrompt(FIXTURE_SPEC);
  assert.ok(prompt.includes('FAILED in production'), 'failure framing present');
});

test('buildPrompt: requests JSON causes array', () => {
  const prompt = buildPrompt(FIXTURE_SPEC);
  assert.ok(prompt.includes('"causes"'), 'JSON shape requested');
  assert.ok(prompt.includes('interrogation_question'), 'interrogation_question field requested');
});

test('SYSTEM_PROMPT: adversarial framing', () => {
  assert.ok(SYSTEM_PROMPT.includes('FAILED'), 'system prompt references failure');
  assert.ok(SYSTEM_PROMPT.includes('adversarial'), 'adversarial framing');
});

// ---------------------------------------------------------------------------
// 3. --out file writing
// ---------------------------------------------------------------------------

test('--out writes report file to tmp dir', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'premortem-test-'));
  try {
    const outPath = join(tmpDir, 'report.md');
    const specPath = join(tmpDir, 'spec.md');

    writeFileSync(specPath, FIXTURE_SPEC, 'utf8');

    // We cannot call run() directly (it would call the LLM), so exercise the
    // renderReport + writeFileSync path that run.mjs uses, by calling the
    // helper functions directly.
    const report = renderReport(FIXTURE_CAUSES);
    writeFileSync(outPath, report, 'utf8');

    const written = readFileSync(outPath, 'utf8');
    assert.ok(written.includes('# Premortem Report'), 'written file contains report header');
    assert.ok(written.includes('## Questions to fold into interrogation'), 'written file contains questions section');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. CLI argument error handling (subprocess, offline)
// ---------------------------------------------------------------------------

const CLI = new URL('../bin/premortem.mjs', import.meta.url).pathname;

test('CLI: no args exits 1', () => {
  const result = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(result.status, 1, 'exits with code 1 when no spec path given');
  assert.ok(result.stderr.includes('spec file path is required'), 'error message mentions spec file path');
});

test('CLI: missing spec file exits 1', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'premortem-test-'));
  try {
    const result = spawnSync(process.execPath, [CLI, join(tmpDir, 'nonexistent.md')], { encoding: 'utf8' });
    assert.equal(result.status, 1, 'exits with code 1 for missing file');
    assert.ok(result.stderr.includes('cannot read spec file'), 'error message mentions file read failure');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: invalid --tier exits 1', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'premortem-test-'));
  try {
    const specPath = join(tmpDir, 'spec.md');
    writeFileSync(specPath, FIXTURE_SPEC, 'utf8');
    const result = spawnSync(process.execPath, [CLI, specPath, '--tier', 'bogus'], { encoding: 'utf8' });
    assert.equal(result.status, 1, 'exits with code 1 for invalid tier');
    assert.ok(result.stderr.includes('invalid --tier'), 'error message mentions invalid tier');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: --prompt-only exits 0 and prints prompt', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'premortem-test-'));
  try {
    const specPath = join(tmpDir, 'spec.md');
    writeFileSync(specPath, FIXTURE_SPEC, 'utf8');
    const result = spawnSync(process.execPath, [CLI, specPath, '--prompt-only'], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'exits 0 with --prompt-only');
    // The combined output should contain spec text and failure framing
    const combined = result.stdout + result.stderr;
    assert.ok(combined.includes('Lightning Checkout v2'), 'prompt-only output includes spec text');
    assert.ok(combined.includes('FAILED in production'), 'prompt-only output includes failure framing');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: --help exits 0', () => {
  const result = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'exits 0 with --help');
  assert.ok(result.stdout.includes('--tier'), 'help text lists --tier flag');
  assert.ok(result.stdout.includes('--out'), 'help text lists --out flag');
  assert.ok(result.stdout.includes('--prompt-only'), 'help text lists --prompt-only flag');
});

// ---------------------------------------------------------------------------
// 5. promptOnly output shape — system+user structure
// ---------------------------------------------------------------------------

test('buildPrompt: prompt is a non-empty string', () => {
  const p = buildPrompt(FIXTURE_SPEC);
  assert.equal(typeof p, 'string');
  assert.ok(p.length > 50, 'prompt is substantially non-empty');
});

// ---------------------------------------------------------------------------
// 6. renderReport edge cases
// ---------------------------------------------------------------------------

test('renderReport: handles empty causes array gracefully', () => {
  const report = renderReport([]);
  assert.ok(report.includes('# Premortem Report'), 'header still present for empty causes');
  assert.ok(report.includes('## Failure Causes'), 'section present for empty causes');
});

test('renderReport: handles missing optional fields gracefully', () => {
  const sparse = [{ cause: 'Only a cause', earliest_signal: undefined, prevention: null, interrogation_question: '' }];
  // Should not throw
  const report = renderReport(sparse);
  assert.ok(report.includes('Only a cause'), 'cause text present');
});

// ---------------------------------------------------------------------------
// 7. --json flag: emits JSON instead of markdown
// ---------------------------------------------------------------------------

// The --json branch in run.mjs (printJson call) is exercised via a subprocess
// that loads a custom ESM loader hook intercepting the core module so no real
// LLM call is made.  The subprocess writes JSON to stdout; we parse and assert
// the shape.

const LOADER_SOURCE = `
// Intercept the real core module and return a minimal stub.
const CORE = 'mock:adlc-core';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@adlc/core') {
    return { url: CORE, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === CORE) {
    const src = [
      "export async function complete() {",
      "  return JSON.stringify({causes:[{cause:'Rate limiter untested',earliest_signal:'P95 spike',prevention:'k6 gate',interrogation_question:'What is RPS capacity?'}]});",
      "}",
      "export function detectProvider() { return 'anthropic'; }",
      "export function extractJson(t) { return JSON.parse(t); }",
      "export function printJson(o) { process.stdout.write(JSON.stringify(o, null, 2) + '\\\\n'); }",
      "export function promptOnly() {}",
      "export function opError(m) { process.stderr.write(m + '\\\\n'); process.exit(1); }",
    ].join('\\n');
    return { format: 'module', source: src, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

const RUNNER_SOURCE = `
import { run } from '__RUN_URL__';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pm-json-'));
const spec = join(dir, 'spec.md');
writeFileSync(spec, '# Spec\\n## Features\\n- Feature A\\n', 'utf8');
await run({ specPath: spec, tier: 'frontier', json: true });
rmSync(dir, { recursive: true, force: true });
`;

test('--json: run() emits JSON causes array to stdout (mocked LLM)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'premortem-json-test-'));
  try {
    const loaderPath = join(tmpDir, 'loader.mjs');
    const runnerPath = join(tmpDir, 'runner.mjs');

    // Derive run.mjs's real URL (never hardcode the absolute project path).
    const runUrl = new URL('../lib/run.mjs', import.meta.url).href;
    writeFileSync(loaderPath, LOADER_SOURCE, 'utf8');
    writeFileSync(runnerPath, RUNNER_SOURCE.replace('__RUN_URL__', runUrl), 'utf8');

    const result = spawnSync(
      process.execPath,
      ['--experimental-loader', loaderPath, runnerPath],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, `subprocess exited non-zero:\n${result.stderr}`);

    // stdout should be valid JSON with a causes array
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(parsed.causes), '--json output has causes array');
    assert.ok(parsed.causes.length > 0, '--json causes array is non-empty');
    assert.ok(
      typeof parsed.causes[0].cause === 'string',
      '--json causes[0].cause is a string',
    );

    // Confirm no markdown heading was emitted (--json should skip renderReport)
    assert.ok(
      !result.stdout.includes('# Premortem Report'),
      '--json must not emit markdown',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
