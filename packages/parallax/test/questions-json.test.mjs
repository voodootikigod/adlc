// Tests for --questions-json: the structured question contract consumed by
// P1 interrogation flows (docs/interrogation-protocol.md) instead of scraping
// the rendered markdown report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { renderQuestionsJson, renderRouteQuestionsJson } from '../lib/scoring.mjs';

const BIN = new URL('../bin/parallax.mjs', import.meta.url).pathname;
const NODE = process.execPath;

function run(args, opts = {}) {
  return spawnSync(NODE, [BIN, ...args], { encoding: 'utf8', timeout: 10000, ...opts });
}

test('renderQuestionsJson: maps divergences to questions verbatim', () => {
  const payload = renderQuestionsJson({
    mode: 'spec',
    divergences: [
      {
        point: 'How should errors be returned?',
        options: [
          { label: 'A', reading: 'HTTP 4xx with error body' },
          { label: 'B', reading: 'Always 200 with error field' },
        ],
      },
    ],
    score: 0.5,
    threshold: 0.25,
  });
  assert.equal(payload.mode, 'spec');
  assert.equal(payload.questions.length, 1);
  assert.equal(payload.questions[0].point, 'How should errors be returned?');
  assert.deepEqual(payload.questions[0].options, [
    { label: 'A', reading: 'HTTP 4xx with error body' },
    { label: 'B', reading: 'Always 200 with error field' },
  ]);
  assert.equal(payload.score, 0.5);
  assert.equal(payload.threshold, 0.25);
  assert.equal(payload.gate, false);
});

test('renderQuestionsJson: no divergences → empty questions, gate true', () => {
  const payload = renderQuestionsJson({ mode: 'edge', divergences: [], score: 0, threshold: 0.25 });
  assert.deepEqual(payload.questions, []);
  assert.equal(payload.gate, true);
  assert.equal(payload.mode, 'edge');
});

test('renderQuestionsJson: gate true exactly at threshold', () => {
  const payload = renderQuestionsJson({ mode: 'spec', divergences: [], score: 0.25, threshold: 0.25 });
  assert.equal(payload.gate, true);
});

test('renderRouteQuestionsJson: one question, variants labelled A/B/C', () => {
  const payload = renderRouteQuestionsJson('Which database?', ['PostgreSQL', 'MySQL', 'SQLite']);
  assert.equal(payload.mode, 'route');
  assert.equal(payload.gate, false);
  assert.equal(payload.questions.length, 1);
  assert.equal(payload.questions[0].point, 'Which database?');
  assert.deepEqual(payload.questions[0].options, [
    { label: 'A', reading: 'PostgreSQL' },
    { label: 'B', reading: 'MySQL' },
    { label: 'C', reading: 'SQLite' },
  ]);
});

test('--questions-json with --prompt-only → exit 1', () => {
  const r = run(['--request', 'Add a login page', '--prompt-only', '--questions-json']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error:'));
});

test('--questions-json with --json → exit 1', () => {
  const r = run(['--request', 'Add a login page', '--json', '--questions-json']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error:'));
});
