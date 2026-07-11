// Tests that coldstart --all skips completed (tombstoned) tickets, while an
// explicit by-id coldstart of a completed ticket still works (you can always
// audit a ticket you name). The activeTickets helper is unit-tested in full
// under merge-forecast; here we sanity-check this package's own copy and prove
// the --all vs by-id wire-up through the CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { activeTickets } from '../lib/active-tickets.mjs';

const CLI = fileURLToPath(new URL('../bin/coldstart.mjs', import.meta.url));

function writeTickets(dir, tickets) {
  const path = join(dir, 'tickets.json');
  writeFileSync(path, JSON.stringify({ tickets }, null, 2));
  return path;
}

function runCLI(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined },
    encoding: 'utf8',
  });
}

const TICKETS = [
  { id: 'T1', title: 'open work', scope: ['a/**'] },
  { id: 'T2', title: 'shipped', completed: true, scope: ['b/**'] },
];

test('activeTickets (local copy): drops completed:true', () => {
  assert.deepEqual(activeTickets(TICKETS).map((t) => t.id), ['T1']);
});

test('coldstart --all --prompt-only audits only the active ticket, skipping the completed one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coldstart-active-'));
  try {
    const path = writeTickets(dir, TICKETS);
    const { status, stdout } = runCLI(['--all', '--prompt-only', '--tickets', path], dir);
    assert.equal(status, 0);
    assert.match(stdout, /user \(T1\)/);
    assert.doesNotMatch(stdout, /user \(T2\)/); // completed ticket skipped
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coldstart of a completed ticket BY ID still emits its prompt (by-id uses the full set, not just active backlog)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coldstart-active-byid-'));
  try {
    const path = writeTickets(dir, TICKETS);
    const { status, stdout } = runCLI(['T2', '--prompt-only', '--tickets', path], dir);
    assert.equal(status, 0);
    assert.match(stdout, /user \(T2\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coldstart --all when EVERY ticket is completed is an operational error, not a silent empty pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coldstart-active-empty-'));
  try {
    const path = writeTickets(dir, [{ id: 'T2', title: 'shipped', completed: true, scope: ['b/**'] }]);
    const { status, stderr } = runCLI(['--all', '--prompt-only', '--tickets', path], dir);
    assert.equal(status, 1);
    assert.match(stderr, /no active tickets/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
