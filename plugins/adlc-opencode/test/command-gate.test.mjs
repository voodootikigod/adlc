// command-gate.test.mjs — T32 AC3: both command.execute.before advisories,
// including the no-warning happy paths. Advisory only — these never block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync as readFileSyncSafe } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeCommandName, checkCommandOrder, checkCommandTamper,
} from '../lib/command-gate.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // plugins/adlc-opencode
const ON = { ADLC_P4_ENFORCEMENT: '1' };

function repo({ tickets = [{ id: 'T1', rails: ['test/**'] }], manifest = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-cmd-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }));
  if (manifest) writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), manifest);
  return dir;
}

// ---- normalizeCommandName ----
test('normalizeCommandName: strips slash + args, rejects non-adlc commands', () => {
  assert.equal(normalizeCommandName('/adlc-decompose'), 'adlc-decompose');
  assert.equal(normalizeCommandName('adlc-prosecute T1'), 'adlc-prosecute');
  assert.equal(normalizeCommandName('/help'), '');
  assert.equal(normalizeCommandName('git status'), '');
  assert.equal(normalizeCommandName(undefined), '');
});

// ---- AC3a: lifecycle-order advisory ----
// The evidence shape is grounded in the runner's real model (see the drift-pin
// test below): P1 = spec-lint/premortem, P2 = coldstart/merge-forecast, carried
// under `type` (canonical) or `gate` (legacy fallback).
const evEntry = (evidence, ticket, key = 'type') => JSON.stringify({ seq: 1, [key]: evidence, ticket }) + '\n';

test('AC3: /adlc-decompose with NO P1 evidence → warns', () => {
  const dir = repo({ tickets: [{ id: 'T1', rails: [] }] });
  try {
    const r = checkCommandOrder('/adlc-decompose', dir, { ...ON, ADLC_TICKET: 'T1' });
    assert.match(r.warn, /lifecycle.*adlc-decompose.*P1 spec gate/s);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC3: /adlc-decompose WITH P1 evidence → no warning (spec-lint & premortem, type & gate keys)', () => {
  for (const evidence of ['spec-lint', 'premortem']) {
    for (const key of ['type', 'gate']) {
      const dir = repo({ tickets: [{ id: 'T1', rails: [] }], manifest: evEntry(evidence, 'T1', key) });
      try {
        assert.equal(checkCommandOrder('/adlc-decompose', dir, { ...ON, ADLC_TICKET: 'T1' }).warn, null, `${evidence}/${key}`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }
});

test('AC3: a P2 gate (coldstart) does NOT satisfy the P1 prerequisite for /adlc-decompose', () => {
  const dir = repo({ tickets: [{ id: 'T1', rails: [] }], manifest: evEntry('coldstart', 'T1') });
  try {
    assert.match(checkCommandOrder('/adlc-decompose', dir, { ...ON, ADLC_TICKET: 'T1' }).warn, /P1 spec gate/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC3: P1 evidence for a DIFFERENT ticket does not satisfy this one', () => {
  const dir = repo({ tickets: [{ id: 'T1', rails: [] }, { id: 'T2', rails: [] }], manifest: evEntry('spec-lint', 'T2') });
  try {
    assert.match(checkCommandOrder('/adlc-decompose', dir, { ...ON, ADLC_TICKET: 'T1' }).warn, /P1 spec gate/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC3: /adlc-prosecute with no P2 evidence → warns; with coldstart (type or gate) → silent', () => {
  const noEvidence = repo({ tickets: [{ id: 'T1', rails: [] }] });
  const typeEv = repo({ tickets: [{ id: 'T1', rails: [] }], manifest: evEntry('coldstart', 'T1', 'type') });
  const gateEv = repo({ tickets: [{ id: 'T1', rails: [] }], manifest: evEntry('coldstart', 'T1', 'gate') });
  try {
    assert.match(checkCommandOrder('/adlc-prosecute', noEvidence, { ...ON, ADLC_TICKET: 'T1' }).warn, /P2 evidence/);
    assert.equal(checkCommandOrder('/adlc-prosecute', typeEv, { ...ON, ADLC_TICKET: 'T1' }).warn, null);
    assert.equal(checkCommandOrder('/adlc-prosecute', gateEv, { ...ON, ADLC_TICKET: 'T1' }).warn, null);
  } finally {
    for (const d of [noEvidence, typeEv, gateEv]) rmSync(d, { recursive: true, force: true });
  }
});

test('AC3 drift-pin: PHASE_PREREQ evidence names match the runner authoritative phase model', async () => {
  // Anti-hollow-test: ground the prerequisite gate lists in the runner's own
  // requirementsForPhase, not hand-picked names. If the runner changes what
  // counts as P1/P2 evidence, this fails instead of the advisory silently
  // drifting. Imported via the monorepo path (dev-only: no runtime dependency
  // is added to the published plugin — it keeps its minimal dep surface).
  const { requirementsForPhase } = await import('../../../packages/runner/lib/assertions.mjs');
  const { PHASE_PREREQ } = await import('../lib/command-gate.mjs');
  // Exact set-equality both ways: if the runner ADDS or removes a P1/P2 gate,
  // the prereq lists must move with it (a subset check would let a newly-added
  // gate stale the advisory silently — codex round-3 note).
  assert.deepEqual(new Set(PHASE_PREREQ['adlc-decompose'].gates), new Set(requirementsForPhase('p1')));
  assert.deepEqual(new Set(PHASE_PREREQ['adlc-prosecute'].gates), new Set(requirementsForPhase('p2')));
});

test('AC3: unmapped command, no active ticket, or non-adlc command → never warns', () => {
  const dir = repo({ tickets: [{ id: 'T1', rails: [] }] });
  try {
    assert.equal(checkCommandOrder('/adlc-spec', dir, { ...ON, ADLC_TICKET: 'T1' }).warn, null); // no prereq
    assert.equal(checkCommandOrder('/adlc-decompose', dir, ON).warn, null);                       // no active ticket
    assert.equal(checkCommandOrder('/help', dir, { ...ON, ADLC_TICKET: 'T1' }).warn, null);       // not adlc
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- AC3b: tamper notice ----
test('AC3: a locally-modified deployed command → tamper warning', () => {
  const dir = repo();
  try {
    mkdirSync(join(dir, '.opencode', 'commands'), { recursive: true });
    writeFileSync(join(dir, '.opencode', 'commands', 'adlc-spec.md'), 'HACKED PROMPT');
    const r = checkCommandTamper('/adlc-spec', PKG, dir);
    assert.match(r.warn, /locally modified/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC3: a pristine deployed command (byte-identical to source) → no warning', () => {
  const dir = repo();
  try {
    const src = readFileSyncSafe(join(PKG, 'command', 'adlc-spec.md'));
    mkdirSync(join(dir, '.opencode', 'commands'), { recursive: true });
    writeFileSync(join(dir, '.opencode', 'commands', 'adlc-spec.md'), src);
    assert.equal(checkCommandTamper('/adlc-spec', PKG, dir).warn, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC3: no deployed copy (or non-adlc command) → no warning (nothing to prove)', () => {
  const dir = repo();
  try {
    assert.equal(checkCommandTamper('/adlc-spec', PKG, dir).warn, null); // not deployed
    assert.equal(checkCommandTamper('/help', PKG, dir).warn, null);      // not adlc
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- host-safety: the command.execute.before WRAPPER must swallow helper throws ----
import { adlcRailsGuard } from '../index.mjs';

test('command.execute.before hook never throws, even on a malformed command payload', async () => {
  const dir = repo();
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    const hooks = await adlcRailsGuard({ worktree: dir });
    // Shapes that could trip a helper: missing command, non-string, an adlc
    // command with no deployed copy, and a genuinely tampered deployed command.
    await hooks['command.execute.before']({});
    await hooks['command.execute.before']({ command: 123 });
    await hooks['command.execute.before']({ command: '/adlc-decompose', sessionID: 's', arguments: '' });
    mkdirSync(join(dir, '.opencode', 'commands'), { recursive: true });
    writeFileSync(join(dir, '.opencode', 'commands', 'adlc-spec.md'), 'HACKED');
    await hooks['command.execute.before']({ command: '/adlc-spec', sessionID: 's', arguments: '' });
    // reaching here without a throw is the assertion (advisory host-safety contract)
    assert.ok(true);
  } finally { Object.assign(process.env, saved); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; rmSync(dir, { recursive: true, force: true }); }
});
