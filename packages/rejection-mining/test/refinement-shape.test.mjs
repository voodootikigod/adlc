// A refinement counts only when the provider returns a non-empty string title
// and charter. Any other shape is a failed refinement: it never reaches the
// report or a lens file, and when every cluster fails the run exits 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';

const BIN = fileURLToPath(new URL('../bin/rejection-mining.mjs', import.meta.url));

function fakeGh(dir) {
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 2.40.0'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify([{ number: 1, title: 'PR 1' }, { number: 2, title: 'PR 2' }]));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify({
    reviews: [
      { body: "don't expose raw errors to clients", author: { login: 'alice' } },
      { body: "never expose raw errors in responses", author: { login: 'bob' } }
    ],
    comments: []
  }));
  process.exit(0);
}
process.exit(1);
`;
  writeFileSync(join(dir, 'gh'), script, { mode: 0o755 });
}

function fakeAgy(dir, response) {
  const path = join(dir, 'fake-agy');
  const script = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(response)}); });
`;
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

function run(dir, response, extra) {
  fakeGh(dir);
  const agy = fakeAgy(dir, response);
  return spawnSync(process.execPath, [BIN, '--llm', '--min', '2', '--out-dir', join(dir, 'lenses'), ...extra], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      ADLC_PROVIDER: 'agy',
      ADLC_AGY: agy,
    },
  });
}

const BAD_SHAPES = [
  ['numeric title, object charter', '{"title": 12345, "charter": {"nested": true}}'],
  ['array fields', '{"title": ["a"], "charter": ["b"]}'],
  ['whitespace-only strings', '{"title": "   ", "charter": "\\t"}'],
  ['string title, numeric charter', '{"title": "Raw errors", "charter": 7}'],
];

for (const [label, response] of BAD_SHAPES) {
  test(`--json --write: ${label} is a failed refinement and exits 1 without writing a lens`, (t) => {
    const dir = tmp(t, 'rm-shape-');
    const res = run(dir, response, ['--json', '--write']);
    assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stderr, /LLM refinement failed for all clusters/);
    assert.doesNotMatch(res.stdout, /"refined": true/);
    assert.equal(existsSync(join(dir, 'lenses')), false, 'no lens may be written from a rejected refinement');
  });

  test(`human mode: ${label} exits 1 with an operational error, not a crash`, (t) => {
    const dir = tmp(t, 'rm-shape-');
    const res = run(dir, response, []);
    assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.doesNotMatch(res.stderr, /TypeError/);
    assert.match(res.stderr, /LLM refinement failed for all clusters/);
  });
}

test('a string title and charter are trimmed and reported as refined', (t) => {
  const dir = tmp(t, 'rm-shape-');
  const res = run(dir, '{"title": "  Raw errors leak  ", "charter": "  Refute that errors are sanitized.  "}', ['--json', '--write']);
  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.lenses.length, 1);
  assert.equal(out.lenses[0].refined, true);
  assert.equal(out.lenses[0].title, 'Raw errors leak');
  const lenses = readdirSync(join(dir, 'lenses'));
  assert.equal(lenses.length, 1);
  const body = readFileSync(join(dir, 'lenses', lenses[0]), 'utf8');
  assert.match(body, /# Lens: Raw errors leak\n/);
  assert.match(body, /attempt to refute: Refute that errors are sanitized\.\n/);
});
