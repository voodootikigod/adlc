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
test('AC3: /adlc-decompose with NO approved-spec evidence → warns', () => {
  const dir = repo({ tickets: [{ id: 'T1', rails: [] }] });
  try {
    const r = checkCommandOrder('/adlc-decompose', dir, { ...ON, ADLC_TICKET: 'T1' });
    assert.match(r.warn, /lifecycle.*adlc-decompose.*approved spec/s);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC3: /adlc-decompose WITH a spec-lint manifest entry for the ticket → no warning (happy path)', () => {
  const dir = repo({
    tickets: [{ id: 'T1', rails: [] }],
    manifest: JSON.stringify({ seq: 1, gate: 'spec-lint', ticket: 'T1' }) + '\n',
  });
  try {
    assert.equal(checkCommandOrder('/adlc-decompose', dir, { ...ON, ADLC_TICKET: 'T1' }).warn, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC3: prerequisite evidence for a DIFFERENT ticket does not satisfy this one', () => {
  const dir = repo({
    tickets: [{ id: 'T1', rails: [] }, { id: 'T2', rails: [] }],
    manifest: JSON.stringify({ seq: 1, gate: 'spec-lint', ticket: 'T2' }) + '\n',
  });
  try {
    assert.match(checkCommandOrder('/adlc-decompose', dir, { ...ON, ADLC_TICKET: 'T1' }).warn, /approved spec/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC3: /adlc-prosecute with no coldstart evidence → warns; with it → silent', () => {
  const noEvidence = repo({ tickets: [{ id: 'T1', rails: [] }] });
  const withEvidence = repo({
    tickets: [{ id: 'T1', rails: [] }],
    manifest: JSON.stringify({ seq: 1, gate: 'coldstart', ticket: 'T1' }) + '\n',
  });
  try {
    assert.match(checkCommandOrder('/adlc-prosecute', noEvidence, { ...ON, ADLC_TICKET: 'T1' }).warn, /decomposed/);
    assert.equal(checkCommandOrder('/adlc-prosecute', withEvidence, { ...ON, ADLC_TICKET: 'T1' }).warn, null);
  } finally {
    rmSync(noEvidence, { recursive: true, force: true });
    rmSync(withEvidence, { recursive: true, force: true });
  }
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
