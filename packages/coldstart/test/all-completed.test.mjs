// `coldstart --all` is the P2 executability audit of the open backlog. A store
// with nothing to audit is an operational error (exit 1), never an empty pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';

const CLI = fileURLToPath(new URL('../bin/coldstart.mjs', import.meta.url));

function runAll(t, tickets) {
  const dir = tmp(t, 'coldstart-all-');
  const path = join(dir, 'tickets.json');
  writeFileSync(path, JSON.stringify({ tickets }));
  return spawnSync(process.execPath, [CLI, '--all', '--prompt-only', '--tickets', path], { cwd: dir, encoding: 'utf8' });
}

test('coldstart --all when every ticket is completed exits 1 naming the cause', (t) => {
  const result = runAll(t, [{ id: 'T1', title: 'shipped', completed: true, scope: ['b/**'] }]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /no active tickets found \(all tickets are completed\)/);
  assert.equal(result.stdout, '');
});

test('coldstart --all on an empty ticket file exits 1 naming the cause', (t) => {
  const result = runAll(t, []);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /no tickets found in ticket file/);
  assert.equal(result.stdout, '');
});
