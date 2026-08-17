// CLI-level exit-code contract for `adlc run <phase>` (0/1/2 — see
// packages/runner/bin/adlc.mjs's --help). Codex cross-model review, round 4:
// a REJECTED p0/p1 gate (unresolved gaps, a rejected verdict, stale
// evidence) was misreported via operational:true, exiting 1 (operational
// error) instead of 2 (gate fails with reasons) — automation branching on
// exit code would retry/abort a fixable content problem instead of treating
// it as an actionable rejection. Driven through the REAL CLI binary, not the
// lib directly, because the bug was in how assertPhase's result shape was
// mapped to a process exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { appendManifestEntry } from '@adlc/gate-manifest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'adlc.mjs');

function tmpAdlc() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-runner-cli-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTicketDefinition(dir, id) {
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [{ id, title: 't', scope: [], rails: [], edges: [] }] }));
}

test('CLI: a REJECTED p0 gate (coldstart gaps present) exits 2, not 1', () => {
  const dir = tmpAdlc();
  writeTicketDefinition(dir, 'T1');
  appendManifestEntry(
    { gate: 'coldstart', ticket: 'T1', data: { verdict: JSON.stringify({ gaps: [{ what: 'x', why_blocking: 'y' }], ticketHash: 'anything' }) } },
    dir, { key: null }
  );
  const r = spawnSync(process.execPath, [BIN, 'run', 'p0', '--dir', dir, '--ticket', 'T1'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `expected exit 2 (gate fails with reasons), got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /evidence rejected/);
});

test('CLI: a REJECTED p1 gate (spec-approval with unresolved > 0) exits 2, not 1', () => {
  const dir = tmpAdlc();
  appendManifestEntry({ gate: 'spec-lint', ticket: 'T1' }, dir, { key: null });
  appendManifestEntry({ gate: 'premortem', ticket: 'T1' }, dir, { key: null });
  appendManifestEntry({
    gate: 'spec-approval', ticket: 'T1',
    data: { verdict: 'approved', approver: 'human', rounds: 1, questions: 1, sources: ['parallax'], unresolved: 2 },
  }, dir, { key: null });
  const r = spawnSync(process.execPath, [BIN, 'run', 'p1', '--dir', dir, '--ticket', 'T1'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `expected exit 2 (gate fails with reasons), got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /evidence rejected/);
});

test('CLI: --json still reports operational:false and the errors array for a rejected p1 gate', () => {
  const dir = tmpAdlc();
  appendManifestEntry({ gate: 'spec-lint', ticket: 'T1' }, dir, { key: null });
  appendManifestEntry({ gate: 'premortem', ticket: 'T1' }, dir, { key: null });
  appendManifestEntry({
    gate: 'spec-approval', ticket: 'T1',
    data: { verdict: 'rejected', approver: 'human', rounds: 1, questions: 1, sources: ['parallax'], unresolved: 0 },
  }, dir, { key: null });
  const r = spawnSync(process.execPath, [BIN, 'run', 'p1', '--dir', dir, '--ticket', 'T1', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.operational, false);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((e) => e.includes('verdict')));
});

test('CLI: a genuine operational error (unknown phase) still exits 1', () => {
  const dir = tmpAdlc();
  const r = spawnSync(process.execPath, [BIN, 'run', 'p9', '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
});

// Codex cross-model review, round 5: --help's "Phases:" line omitted p0 (this
// PR added the p0 gate) and "Ticket required:" omitted p0/p1 (this PR made
// both ticket-required) — hand-typed strings drifted from the actual
// PHASE_REQUIREMENTS/requiresTicket source of truth. Asserting against every
// phase individually (not a hard-coded expected string) means a future phase
// addition/removal fails this test loudly instead of silently drifting again.
test('CLI: --help lists every phase and every ticket-required phase, matching the runner source of truth', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  for (const phase of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']) {
    assert.match(r.stdout, new RegExp(`Phases:.*\\b${phase}\\b`), `--help must list ${phase}`);
  }
  for (const phase of ['p0', 'p1', 'p3', 'p4', 'p5', 'p6']) {
    assert.match(r.stdout, new RegExp(`Ticket required:.*\\b${phase}\\b`), `--help must list ${phase} as ticket-required`);
  }
  for (const phase of ['p2', 'p7']) {
    assert.doesNotMatch(r.stdout, new RegExp(`Ticket required:.*\\b${phase}\\b`), `--help must NOT list ${phase} as ticket-required`);
  }
});
