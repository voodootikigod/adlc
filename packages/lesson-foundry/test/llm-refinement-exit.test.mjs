// --llm is a request for refined wording. When no cluster is refined the run
// exits 1 before writing anything; when some are, the report says which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';
import { buildHumanReport, buildJsonResult } from '../lib/report.mjs';
import { toRefinement } from '../lib/llm.mjs';

const BIN = resolve(new URL('../bin/lesson-foundry.mjs', import.meta.url).pathname);

const LINT_ENTRIES = [
  { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check before calling "db.query"' },
  { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check before calling "db.query"' },
];

function writeLedger(dir, entries) {
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'findings.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function fakeAgy(dir, response) {
  const path = join(dir, 'fake-agy');
  writeFileSync(path, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(response)}); });
`, { mode: 0o755 });
  return path;
}

const NO_PROVIDER = {
  ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', ADLC_AGY: 'off', ADLC_PROVIDER: '',
};

function run(dir, args, env) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

test('--llm --write with no provider exits 1 and writes no artifact', (t) => {
  const dir = tmp(t, 'lf-llm-exit-');
  writeLedger(dir, LINT_ENTRIES);
  const outDir = join(dir, '.adlc', 'lessons');
  const res = run(dir, ['--llm', '--write', '--out-dir', outDir], NO_PROVIDER);
  assert.equal(res.code, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /LLM refinement failed for all clusters\. Use --prompt-only to inspect prompts\./);
  assert.doesNotMatch(res.stdout, /lesson-foundry: done\./);
  assert.equal(existsSync(outDir), false, 'no artifact may be written when refinement was requested and none happened');
});

test('--llm --json with no provider exits 1', (t) => {
  const dir = tmp(t, 'lf-llm-exit-');
  writeLedger(dir, LINT_ENTRIES);
  const res = run(dir, ['--llm', '--json'], NO_PROVIDER);
  assert.equal(res.code, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /LLM refinement failed for all clusters/);
});

for (const [label, reply] of [
  ['non-string fields', '{"name": 1, "description": {"x": 1}, "rule": ["r"]}'],
  ['whitespace-only fields', '{"name": " ", "description": " ", "rule": " "}'],
]) {
  test(`--llm with a provider replying ${label} exits 1`, (t) => {
    const dir = tmp(t, 'lf-llm-exit-');
    writeLedger(dir, LINT_ENTRIES);
    const res = run(dir, ['--llm', '--json'], { ...NO_PROVIDER, ADLC_PROVIDER: 'agy', ADLC_AGY: fakeAgy(dir, reply) });
    assert.equal(res.code, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stderr, /LLM refinement failed for all clusters/);
  });
}

test('--llm with a valid reply exits 0 and marks the cluster refined', (t) => {
  const dir = tmp(t, 'lf-llm-exit-');
  writeLedger(dir, LINT_ENTRIES);
  const reply = '{"name": "null-check-db-query", "description": "Null check before db.query", "rule": "Check for null before db.query."}';
  const res = run(dir, ['--llm', '--json'], { ...NO_PROVIDER, ADLC_PROVIDER: 'agy', ADLC_AGY: fakeAgy(dir, reply) });
  assert.equal(res.code, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.clusters.length, 1);
  assert.equal(out.clusters[0].refined, true);
});

test('without --llm every cluster reports refined:false', (t) => {
  const dir = tmp(t, 'lf-llm-exit-');
  writeLedger(dir, LINT_ENTRIES);
  const res = run(dir, ['--json'], NO_PROVIDER);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).clusters[0].refined, false);
});

test('report: per-cluster refined flag and a failed-N-of-M line for partial refinement', () => {
  const clusters = [
    { id: 'a', name: 'one', size: 2, route: 'lint', indices: [0, 1], members: [] },
    { id: 'b', name: 'two', size: 2, route: 'skill', indices: [2, 3], members: [] },
  ];
  const refinements = new Map([[1, { name: 'two', description: 'd', rule: 'r' }]]);
  const json = buildJsonResult({ clusters, skipped: 0, filtered: 0, plan: [], gateResult: null, writeSkipped: null, refinements });
  assert.deepEqual(json.clusters.map((c) => c.refined), [false, true]);

  const lines = buildHumanReport({ clusters, skipped: 0, filtered: 0, plan: [], failedRefinements: 1 });
  assert.ok(lines.includes('  LLM refinement failed for 1 of 2 cluster(s); those keep unrefined wording'), lines.join('\n'));

  const clean = buildHumanReport({ clusters, skipped: 0, filtered: 0, plan: [], failedRefinements: 0 });
  assert.ok(!clean.some((l) => l.includes('LLM refinement failed')), clean.join('\n'));

  const withoutLlm = buildHumanReport({ clusters, skipped: 0, filtered: 0, plan: [] });
  assert.ok(!withoutLlm.some((l) => l.includes('LLM refinement failed')), withoutLlm.join('\n'));
});

test('toRefinement requires every field as a non-empty string and trims them', () => {
  assert.deepEqual(
    toRefinement({ name: ' n ', description: ' d ', rule: ' r ', extra: 1 }),
    { name: 'n', description: 'd', rule: 'r' },
  );
  assert.equal(toRefinement({ name: 'n', description: 'd' }), null);
  assert.equal(toRefinement({ name: 'n', rule: 'r' }), null);
  assert.equal(toRefinement({ description: 'd', rule: 'r' }), null);
  assert.equal(toRefinement({ name: 'n', description: 'd', rule: 5 }), null);
  assert.equal(toRefinement(null), null);
});
