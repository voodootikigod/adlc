// P0/P1 gate assertions: p0 requires ticket-scoped, zero-gap, non-stale
// coldstart evidence; p1 requires a human spec-approval record with a valid
// interrogation summary bound to a real, unchanged spec file, recorded after
// the latest spec-lint/premortem evidence
// (.adlc/specs/p0-p1-human-interrogation.md, design D4).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPhase } from '../lib/assertions.mjs';
import { appendManifestEntry as realAppendManifestEntry } from '@adlc/gate-manifest';
import { sha256 } from '@adlc/core';
import { ticketHash as domainTicketHash } from '@adlc/tickets';

const appendManifestEntry = (entry, dir, opts = {}) => realAppendManifestEntry(entry, dir, { key: null, ...opts });

function tmpAdlc() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-runner-p0p1-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(dir, entries) {
  for (const entry of entries) appendManifestEntry(entry, dir);
}

function ticketDefinition(id = 'T1') {
  return { id, title: `${id} fixture`, scope: ['src/**'], rails: [], edges: [] };
}

function writeTicketDefinition(dir, id = 'T1') {
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [ticketDefinition(id)] }));
  return domainTicketHash(ticketDefinition(id));
}

describe('p0 gate', () => {
  it('requires --ticket', () => {
    const dir = tmpAdlc();
    const result = assertPhase('p0', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('requires --ticket')));
  });

  it('fails without a coldstart record', () => {
    const dir = tmpAdlc();
    writeTicketDefinition(dir, 'T1');
    const result = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['coldstart']);
  });

  it('passes with a zero-gap coldstart record bound to the current ticket hash', () => {
    const dir = tmpAdlc();
    const hash = writeTicketDefinition(dir, 'T1');
    writeManifest(dir, [{ gate: 'coldstart', ticket: 'T1', data: { verdict: JSON.stringify({ gaps: [], ticketHash: hash }) } }]);
    const result = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('rejects a coldstart record with unresolved gaps', () => {
    const dir = tmpAdlc();
    const hash = writeTicketDefinition(dir, 'T1');
    writeManifest(dir, [{ gate: 'coldstart', ticket: 'T1', data: { verdict: JSON.stringify({ gaps: [{ what: 'x', why_blocking: 'y' }], ticketHash: hash }) } }]);
    const result = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('gap')));
  });

  it('rejects a coldstart record whose ticketHash is stale (ticket edited after coldstart ran)', () => {
    const dir = tmpAdlc();
    writeManifest(dir, [{ gate: 'coldstart', ticket: 'T1', data: { verdict: JSON.stringify({ gaps: [], ticketHash: 'stale-hash' }) } }]);
    writeTicketDefinition(dir, 'T1');
    const result = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('stale')));
  });

  it('rejects a coldstart record for a different ticket', () => {
    const dir = tmpAdlc();
    const hash = writeTicketDefinition(dir, 'T1');
    writeManifest(dir, [{ gate: 'coldstart', ticket: 'T2', data: { verdict: JSON.stringify({ gaps: [], ticketHash: hash }) } }]);
    const result = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['coldstart']);
  });

  it('rejects an --all-mode coldstart record (not bound to a single ticket)', () => {
    const dir = tmpAdlc();
    const hash = writeTicketDefinition(dir, 'T1');
    writeManifest(dir, [{ gate: 'coldstart', data: { verdict: JSON.stringify({ gaps: [], ticketHash: hash }), ticketIds: ['T1'] } }]);
    const result = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['coldstart']);
  });

  it('rejects a non-JSON coldstart verdict', () => {
    const dir = tmpAdlc();
    writeTicketDefinition(dir, 'T1');
    writeManifest(dir, [{ gate: 'coldstart', ticket: 'T1', data: { verdict: 'looks fine to me' } }]);
    const result = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('JSON')));
  });
});

function specFixture(dir) {
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, '# Spec\nacceptance criteria: `test -f spec.md`\n');
  const hash = sha256(readFileSync(specPath));
  return { specPath, hash };
}

function validApprovalFor(specPath, hash, overrides = {}) {
  return {
    gate: 'spec-approval',
    ticket: 'T1',
    files: specPath === undefined ? {} : { [specPath]: hash },
    data: {
      verdict: 'approved',
      approver: 'human@example.com',
      spec_hash: hash,
      rounds: 2,
      questions: 5,
      sources: ['coldstart', 'parallax'],
      unresolved: 0,
      approved_assumptions: [],
      ...overrides,
    },
  };
}

describe('p1 gate spec-approval requirement', () => {
  it('fails when spec-lint and premortem exist but no spec-approval', () => {
    const dir = tmpAdlc();
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes('spec-approval'));
  });

  it('passes with a valid spec-approval bound to the real spec file, ticket, and recorded after the audits', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, validApprovalFor(specPath, hash)]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('rejects a spec-approval with unresolved > 0', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, validApprovalFor(specPath, hash, { unresolved: 2 })]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('unresolved')));
  });

  it('rejects a legacy spec-approval with no interrogation payload', () => {
    const dir = tmpAdlc();
    writeManifest(dir, [
      { gate: 'spec-lint' },
      { gate: 'premortem' },
      { gate: 'spec-approval', data: { approver: 'human', verdict: 'approved' } },
    ]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects a spec-approval with no data at all', () => {
    const dir = tmpAdlc();
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, { gate: 'spec-approval' }]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects non-array approved_assumptions', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, validApprovalFor(specPath, hash, { approved_assumptions: 'trust me' })]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('approved_assumptions')));
  });

  it('validates the latest spec-approval, so a corrected re-approval heals a bad one', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [
      { gate: 'spec-lint' },
      { gate: 'premortem' },
      validApprovalFor(specPath, hash, { unresolved: 1 }),
      validApprovalFor(specPath, hash),
    ]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('rejects a rejected verdict, even with an otherwise-complete payload', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, validApprovalFor(specPath, hash, { verdict: 'rejected' })]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('verdict')));
  });

  it('rejects a missing verdict field', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    const approval = validApprovalFor(specPath, hash);
    delete approval.data.verdict;
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, approval]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('verdict')));
  });

  it('rejects an empty approver', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, validApprovalFor(specPath, hash, { approver: '' })]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('approver')));
  });

  it('rejects an approval not bound to a ticket', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    const approval = validApprovalFor(specPath, hash);
    delete approval.ticket;
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, approval]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('ticket')));
  });

  it('rejects an approval with no bound file', () => {
    const dir = tmpAdlc();
    specFixture(dir);
    const approval = validApprovalFor(undefined, undefined);
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, approval]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('exactly one spec file')));
  });

  it('rejects a spec_hash that does not match the actually-recorded file hash (a fabricated hash)', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, validApprovalFor(specPath, hash, { spec_hash: 'a-lie-of-a-hash' })]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('spec_hash')));
  });

  it('rejects a stale approval — the spec file changed after approval was recorded', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, validApprovalFor(specPath, hash)]);
    writeFileSync(specPath, '# Spec\nEDITED after approval — a materially different spec.\n');
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('changed after approval')));
  });

  it('rejects an approval recorded before the latest spec-lint evidence', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [
      { gate: 'premortem' },
      validApprovalFor(specPath, hash),
      { gate: 'spec-lint' },
    ]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('before the latest spec-lint')));
  });

  it('rejects an approval recorded before the latest premortem evidence', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [
      { gate: 'spec-lint' },
      validApprovalFor(specPath, hash),
      { gate: 'premortem' },
    ]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('before the latest premortem')));
  });
});
