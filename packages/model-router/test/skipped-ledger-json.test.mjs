/**
 * Tests for model-router CLI --json mode with skippedLedger and stderr warning.
 * Covers Issue #701 (AC1, AC2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';

const CLI_PATH = new URL('../bin/model-router.mjs', import.meta.url).pathname;

function runCLI(args, cwd) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function setupFixture(dir, { tickets, manifestRaw }) {
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  const ticketsPath = join(adlc, 'tickets.json');
  writeFileSync(ticketsPath, JSON.stringify({ tickets }));
  if (manifestRaw !== undefined) {
    writeFileSync(join(adlc, 'manifest.jsonl'), manifestRaw);
  }
  return ticketsPath;
}

const sampleTickets = [
  {
    id: 'T1',
    title: 'Railed Ticket',
    category: 'feature',
    rails: ['a.test.js'],
    scope: ['a.js'],
  },
];

test('AC1: model-router --json surfaces skippedLedger array in JSON payload', (t) => {
  const dir1 = tmp(t);
  const manifestRaw = '{"type":"build","model":"cheap","category":"feature","firstPass":true}\nmalformed line\n';
  const ticketsPath = setupFixture(dir1, { tickets: sampleTickets, manifestRaw });

  const r = runCLI(['--tickets', ticketsPath, '--json'], dir1);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);

  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.skippedLedger), 'skippedLedger must be an array in JSON output');
  assert.equal(parsed.skippedLedger.length, 1, 'skippedLedger should contain 1 skipped entry');
  assert.equal(parsed.skippedLedger[0].line, 2);
  assert.equal(parsed.skippedLedger[0].segment, 'root');
});

test('AC2: model-router --json prints warning to stderr when malformed lines skipped', (t) => {
  const dir2 = tmp(t);
  const manifestRaw = '{"type":"build","model":"cheap","category":"feature","firstPass":true}\nmalformed 1\nmalformed 2\n';
  const ticketsPath = setupFixture(dir2, { tickets: sampleTickets, manifestRaw });

  const r = runCLI(['--tickets', ticketsPath, '--json'], dir2);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);

  assert.match(
    r.stderr,
    /Warning: 2 malformed ledger line\(s\) skipped\./,
    `stderr should contain warning message in --json mode, got:\n${r.stderr}`
  );

  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.skippedLedger.length, 2);
});

test('model-router --json without malformed lines includes empty skippedLedger and no stderr warning', (t) => {
  const dir3 = tmp(t);
  const manifestRaw = '{"type":"build","model":"cheap","category":"feature","firstPass":true}\n';
  const ticketsPath = setupFixture(dir3, { tickets: sampleTickets, manifestRaw });

  const r = runCLI(['--tickets', ticketsPath, '--json'], dir3);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);

  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.skippedLedger), 'skippedLedger must be an array in JSON output');
  assert.equal(parsed.skippedLedger.length, 0);
  assert.doesNotMatch(r.stderr, /malformed ledger line\(s\) skipped/);
});

test('model-router table mode preserves stderr warning on malformed ledger lines', (t) => {
  const dir4 = tmp(t);
  const manifestRaw = 'malformed line\n';
  const ticketsPath = setupFixture(dir4, { tickets: sampleTickets, manifestRaw });

  const r = runCLI(['--tickets', ticketsPath], dir4);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);

  assert.match(
    r.stderr,
    /Warning: 1 malformed ledger line\(s\) skipped\./,
    `table mode should still emit warning on stderr, got:\n${r.stderr}`
  );
});

test('model-router --json with empty tickets list surfaces skippedLedger and stderr warning', (t) => {
  const dir5 = tmp(t);
  const manifestRaw = 'malformed line\n';
  const ticketsPath = setupFixture(dir5, { tickets: [], manifestRaw });

  const r = runCLI(['--tickets', ticketsPath, '--json'], dir5);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);

  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.skippedLedger), 'skippedLedger must be an array');
  assert.equal(parsed.skippedLedger.length, 1);
  assert.match(
    r.stderr,
    /Warning: 1 malformed ledger line\(s\) skipped\./,
    `stderr should contain warning message in --json mode with empty tickets, got:\n${r.stderr}`
  );
});

test('model-router table mode with empty tickets list still emits stderr warning for malformed ledger', (t) => {
  const dir6 = tmp(t);
  const manifestRaw = 'malformed line\n';
  const ticketsPath = setupFixture(dir6, { tickets: [], manifestRaw });

  const r = runCLI(['--tickets', ticketsPath], dir6);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);

  assert.match(r.stdout, /No tickets found\./);
  assert.match(
    r.stderr,
    /Warning: 1 malformed ledger line\(s\) skipped\./,
    `stderr should contain warning message in table mode with empty tickets, got:\n${r.stderr}`
  );
});

test('model-router --json with all tickets completed surfaces skippedLedger and stderr warning', (t) => {
  const dir7 = tmp(t);
  const manifestRaw = 'malformed line\n';
  const completedTickets = [
    {
      id: 'T1',
      title: 'Completed Ticket',
      category: 'feature',
      completed: true,
      rails: ['a.test.js'],
      scope: ['a.js'],
    },
  ];
  const ticketsPath = setupFixture(dir7, { tickets: completedTickets, manifestRaw });

  const r = runCLI(['--tickets', ticketsPath, '--json'], dir7);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);

  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.skippedLedger), 'skippedLedger must be an array');
  assert.equal(parsed.skippedLedger.length, 1);
  assert.match(
    r.stderr,
    /Warning: 1 malformed ledger line\(s\) skipped\./,
    `stderr should contain warning message in --json mode with all completed tickets, got:\n${r.stderr}`
  );
});
