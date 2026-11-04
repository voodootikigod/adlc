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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { appendManifestEntry } from '@adlc/gate-manifest';
import { tmp } from '@adlc/core/test-kit';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'adlc.mjs');

function tmpAdlc(t) {
  const dir = tmp(t, 'adlc-runner-cli-');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTicketDefinition(dir, id) {
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [{ id, title: 't', scope: [], rails: [], edges: [] }] }));
}

test('CLI: a REJECTED p0 gate (coldstart gaps present) exits 2, not 1', (t) => {
  const dir = tmpAdlc(t);
  writeTicketDefinition(dir, 'T1');
  appendManifestEntry(
    { gate: 'coldstart', ticket: 'T1', data: { verdict: JSON.stringify({ gaps: [{ what: 'x', why_blocking: 'y' }], ticketHash: 'anything' }) } },
    dir, { key: null }
  );
  const r = spawnSync(process.execPath, [BIN, 'run', 'p0', '--dir', dir, '--ticket', 'T1'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `expected exit 2 (gate fails with reasons), got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /evidence rejected/);
});

test('CLI: a REJECTED p1 gate (spec-approval with unresolved > 0) exits 2, not 1', (t) => {
  const dir = tmpAdlc(t);
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

test('CLI: --json still reports operational:false and the errors array for a rejected p1 gate', (t) => {
  const dir = tmpAdlc(t);
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

test('CLI: a genuine operational error (unknown phase) still exits 1', (t) => {
  const dir = tmpAdlc(t);
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
  for (const phase of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
    assert.match(r.stdout, new RegExp(`Ticket required:.*\\b${phase}\\b`), `--help must list ${phase} as ticket-required`);
  }
  for (const phase of ['p7']) {
    assert.doesNotMatch(r.stdout, new RegExp(`Ticket required:.*\\b${phase}\\b`), `--help must NOT list ${phase} as ticket-required`);
  }
  assert.match(r.stdout, /adlc-runner run <phase>/);
  assert.match(r.stdout, /adlc-runner accept --ticket id/);
  assert.match(r.stdout, /@adlc\/cli/);
  assert.match(r.stdout, /2\s+required phase evidence is missing or rejected/);
});

test('CLI: missing verb/phase prints usage naming adlc-runner and adlc run (#763)', () => {
  const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: adlc-runner run <phase>.*adlc run <phase>/);
});

test('CLI: a REJECTED p4 gate (missing railFiles hash snapshot) exits 2, not 1 (#764)', (t) => {
  const dir = tmpAdlc(t);
  appendManifestEntry({ gate: 'p4-build', ticket: 'T1' }, dir, { key: null });
  appendManifestEntry({ gate: 'rails-check', ticket: 'T1', data: { railsDiffEmpty: true, suppressionsClean: true } }, dir, { key: null });
  appendManifestEntry({ gate: 'flail-check', ticket: 'T1' }, dir, { key: null });
  const r = spawnSync(process.execPath, [BIN, 'run', 'p4', '--dir', dir, '--ticket', 'T1'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `expected exit 2 (gate fails with reasons), got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /evidence rejected/);
  assert.match(r.stderr, /missing railFiles hash snapshot/);
});

test('CLI: a REJECTED p5 gate (stale worktree revision, stale ticket, transcript error, or incomplete p5-complete) exits 2, not 1 (#764)', (t) => {
  const dir = tmpAdlc(t);
  writeTicketDefinition(dir, 'T1');
  appendManifestEntry({
    gate: 'p5-complete',
    ticket: 'T1',
    revision: 'git-worktree:0000000000000000000000000000000000000000000000000000000000000000',
  }, dir, { key: null });
  const r = spawnSync(process.execPath, [BIN, 'run', 'p5', '--dir', dir, '--ticket', 'T1', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.operational, false);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((e) => e.includes('P5 evidence is stale')));

  const rPinned = spawnSync(process.execPath, [
    BIN, 'run', 'p5', '--dir', dir, '--ticket', 'T1',
    '--revision', 'git-worktree:0000000000000000000000000000000000000000000000000000000000000000',
  ], { encoding: 'utf8' });
  assert.equal(rPinned.status, 2, `expected exit 2, got ${rPinned.status}\n${rPinned.stdout}${rPinned.stderr}`);
  assert.match(rPinned.stderr, /evidence rejected/);
});

test('CLI: a REJECTED p6 gate (incomplete p6-acceptance-packet) exits 2, not 1 (#764)', async (t) => {
  const dir = tmpAdlc(t);
  const rev = 'git-worktree:1111111111111111111111111111111111111111111111111111111111111111';
  const { sha256 } = await import('@adlc/core');
  const { ticketHash: domainTicketHash } = await import('@adlc/tickets');
  const tDef = { id: 'T1', title: 'T1 fixture', scope: ['src/**'], rails: ['test/**'], edges: [] };
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [tDef] }));
  const transcriptPath = join(dir, 'T1-p5-review.txt');
  const promptPath = join(dir, 'T1-p5-prompt.txt');
  const inputsPath = join(dir, 'T1-p5-inputs.txt');
  writeFileSync(transcriptPath, [
    'ticket: T1',
    `reviewed revision: ${rev}`,
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n'));
  writeFileSync(promptPath, `review prompt for T1 at ${rev}\n`);
  writeFileSync(inputsPath, `reviewed inputs for T1 at ${rev}\n`);
  const dryLenses = ['security', 'correctness', 'tests'];
  dryLenses.forEach((lens, index) => {
    const pass = index + 1;
    appendManifestEntry({ type: 'p5-dry-pass', ticket: 'T1', revision: rev, pass, lens, consecutiveDry: pass }, dir, { key: null });
    appendManifestEntry({ type: 'p5-pass-completed', ticket: 'T1', revision: rev, pass, lens, dry: true, verified: 0, killed: 0, needsHuman: 0, consecutiveDry: pass }, dir, { key: null });
  });
  appendManifestEntry({
    type: 'p5-complete',
    ticket: 'T1',
    revision: rev,
    pass: dryLenses.length,
    consecutiveDry: dryLenses.length,
    provenance: { reviewer: 'fixture-reviewer', command: 'fixture review command', transcript: transcriptPath },
    transcript: { path: transcriptPath, hash: sha256(readFileSync(transcriptPath)) },
    reviewPacket: {
      prompt: { path: promptPath, hash: sha256(readFileSync(promptPath)) },
      inputs: { path: inputsPath, hash: sha256(readFileSync(inputsPath)) },
      cleanWorktree: rev,
    },
    dryLenses,
    ticketHash: domainTicketHash(tDef),
  }, dir, { key: null });
  appendManifestEntry({
    type: 'p6-acceptance-packet',
    ticket: 'T1',
    revision: rev,
  }, dir, { key: null });
  const r = spawnSync(process.execPath, [BIN, 'run', 'p6', '--dir', dir, '--ticket', 'T1', '--revision', rev], { encoding: 'utf8' });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /evidence rejected/);
  assert.match(r.stderr, /missing packet path/);
});
