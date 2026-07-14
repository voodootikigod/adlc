import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-rails-guard.mjs');

function fixture(ticket, fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-codex-rails-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc/tickets.json'), `${JSON.stringify({ tickets: [ticket] }, null, 2)}\n`);
  try { return fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function run(root, env = {}) {
  const { ADLC_P4_ENFORCEMENT: _enforcement, ADLC_TICKET: _ticket, ADLC_TICKETS: _tickets, ADLC_TICKET_STORE: _store, ...base } = process.env;
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    env: { ...base, ...env },
    input: JSON.stringify({ tool_name: 'apply_patch', tool_input: { path: 'test/frozen.test.mjs' } }),
    encoding: 'utf8',
  });
}

const ticket = { id: 'T1', title: 'Active', scope: ['src/**'], rails: ['test/**'], edges: [] };

test('auto-activates from current-ticket.json and denies a rail edit', () => {
  fixture(ticket, (root) => {
    writeFileSync(join(root, '.adlc/current-ticket.json'), '{"id":"T1"}\n');
    const result = run(root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit for T1/);
  });
});

test('no selected ticket is an inactive no-op in auto mode', () => {
  fixture(ticket, (root) => {
    const result = run(root);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /no current ticket selected/);
  });
});

test('explicit off disables auto mode and explicit on requires selection', () => {
  fixture(ticket, (root) => {
    writeFileSync(join(root, '.adlc/current-ticket.json'), '{"id":"T1"}\n');
    assert.equal(run(root, { ADLC_P4_ENFORCEMENT: '0' }).status, 0);
    rmSync(join(root, '.adlc/current-ticket.json'));
    const forced = run(root, { ADLC_P4_ENFORCEMENT: '1' });
    assert.equal(forced.status, 2);
    assert.match(forced.stderr, /no active ticket/);
  });
});

test('conflicting and stale selections fail closed', () => {
  fixture(ticket, (root) => {
    writeFileSync(join(root, '.adlc/current-ticket.json'), '{"id":"T1","ticketHash":"stale"}\n');
    const stale = run(root);
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /changed after selection/);
    writeFileSync(join(root, '.adlc/current-ticket.json'), '{"id":"T1"}\n');
    const conflict = run(root, { ADLC_TICKET: 'T2' });
    assert.equal(conflict.status, 2);
    assert.match(conflict.stderr, /conflicts with/);
  });
});

test('completed or rail-free tickets do not auto-activate', () => {
  fixture({ ...ticket, completed: true }, (root) => {
    writeFileSync(join(root, '.adlc/current-ticket.json'), '{"id":"T1"}\n');
    assert.equal(run(root).status, 0);
  });
  fixture({ ...ticket, rails: [] }, (root) => {
    writeFileSync(join(root, '.adlc/current-ticket.json'), '{"id":"T1"}\n');
    assert.equal(run(root).status, 0);
  });
});
