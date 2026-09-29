// `adlc spend --json` must not under-report silently: malformed ledger lines
// are counted in the payload's `skipped` and warned about on stderr in both
// output modes. Drives the real binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';

const BIN = fileURLToPath(new URL('../bin/spend.mjs', import.meta.url));
const ENTRY = {
  seq: 1,
  gate: 'prosecute',
  ts: '2026-01-01T00:00:00.000Z',
  ticket: 'T1',
  data: { usage: { inputTokens: 10, outputTokens: 5, provider: 'x', model: 'm' } },
  prev: null,
};

function ledger(t, lines) {
  const dir = tmp(t, 'spend-json-');
  writeFileSync(join(dir, 'manifest.jsonl'), lines.map((l) => `${l}\n`).join(''));
  return dir;
}

function spend(dir, ...args) {
  return spawnSync(process.execPath, [BIN, '--dir', dir, ...args], { encoding: 'utf8' });
}

test('--json reports the malformed lines it skipped and warns on stderr', (t) => {
  const dir = ledger(t, [JSON.stringify(ENTRY), 'garbage', '{"half":']);
  const r = spend(dir, '--json');
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.entriesTotal, 1);
  assert.equal(payload.skipped.length, 2);
  assert.match(r.stderr, /warning: 2 malformed manifest line\(s\) skipped/);
});

test('--json on a clean ledger reports an empty skipped list and stays quiet', (t) => {
  const dir = ledger(t, [JSON.stringify(ENTRY)]);
  const r = spend(dir, '--json');
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.deepEqual(payload.skipped, []);
  assert.equal(payload.entriesTotal, 1);
  assert.equal(r.stderr, '');
});

test('table mode keeps its warning and keeps stdout free of JSON', (t) => {
  const dir = ledger(t, [JSON.stringify(ENTRY), 'garbage']);
  const r = spend(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: 1 malformed manifest line\(s\) skipped/);
  assert.throws(() => JSON.parse(r.stdout));
});
