// merge-forecast has nothing to schedule when the backlog holds no active
// ticket; that is an operational error (exit 1), never an empty forecast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';

const CLI = fileURLToPath(new URL('../bin/merge-forecast.mjs', import.meta.url));

function forecast(t, tickets) {
  const dir = tmp(t, 'mf-no-active-');
  const path = join(dir, 'tickets.json');
  writeFileSync(path, JSON.stringify({ tickets }));
  return spawnSync(process.execPath, [CLI, '--tickets', path, '--json'], { cwd: dir, encoding: 'utf8' });
}

test('merge-forecast with only completed tickets exits 1 naming the cause', (t) => {
  const result = forecast(t, [{ id: 'T1', title: 'shipped', completed: true, scope: ['a/**'] }]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /no active tickets found \(all tickets are completed\)/);
});

test('merge-forecast with an empty ticket file exits 1 naming the cause', (t) => {
  const result = forecast(t, []);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /no tickets found/);
  assert.doesNotMatch(result.stderr, /all tickets are completed/);
});
