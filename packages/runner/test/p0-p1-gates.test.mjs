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

  it('passes with a live provider-backed coldstart record (data.cache shape, not data.verdict)', () => {
    const dir = tmpAdlc();
    const hash = writeTicketDefinition(dir, 'T1');
    writeManifest(dir, [{ gate: 'coldstart', ticket: 'T1', data: { tier: 'cheap', cache: { ticketHash: hash, model: 'x', gaps: [] } } }]);
    const result = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('rejects a live provider-backed coldstart record with unresolved gaps', () => {
    const dir = tmpAdlc();
    const hash = writeTicketDefinition(dir, 'T1');
    writeManifest(dir, [{ gate: 'coldstart', ticket: 'T1', data: { tier: 'cheap', cache: { ticketHash: hash, model: 'x', gaps: [{ what: 'x', why_blocking: 'y' }] } } }]);
    const result = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('gap')));
  });

  it('rejects a live provider-backed coldstart record with a stale ticketHash', () => {
    const dir = tmpAdlc();
    writeManifest(dir, [{ gate: 'coldstart', ticket: 'T1', data: { tier: 'cheap', cache: { ticketHash: 'stale-hash', model: 'x', gaps: [] } } }]);
    writeTicketDefinition(dir, 'T1');
    const result = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('stale')));
  });

  it('rejects a coldstart record with neither a cache nor a verdict shape', () => {
    const dir = tmpAdlc();
    writeTicketDefinition(dir, 'T1');
    writeManifest(dir, [{ gate: 'coldstart', ticket: 'T1', data: { tier: 'cheap' } }]);
    const result = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
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

// `specPath`/`hash` bind the SAME spec the approval binds — the default
// (undefined) produces an audit with no --files binding at all, matching a
// hand-crafted `gate-manifest record spec-lint` with no file (must fail the
// match check, not just pass by omission).
function sl(ticket = 'T1', { specPath, hash, verified = true } = {}) {
  return { gate: 'spec-lint', ticket, files: specPath === undefined ? {} : { [specPath]: hash }, data: { verified } };
}
function pm(ticket = 'T1', { specPath, hash } = {}) {
  return { gate: 'premortem', ticket, files: specPath === undefined ? {} : { [specPath]: hash } };
}

describe('p1 gate spec-approval requirement', () => {
  it('requires --ticket', () => {
    const dir = tmpAdlc();
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('requires --ticket')));
  });

  it('fails when spec-lint and premortem exist but no spec-approval', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash })]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes('spec-approval'));
  });

  it('passes with a valid spec-approval bound to the real spec file, ticket, and recorded after the audits', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash)]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('rejects a spec-approval with unresolved > 0', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash, { unresolved: 2 })]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('unresolved')));
  });

  it('rejects a legacy spec-approval with no interrogation payload', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [
      sl('T1', { specPath, hash }), pm('T1', { specPath, hash }),
      { gate: 'spec-approval', ticket: 'T1', data: { approver: 'human', verdict: 'approved' } },
    ]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects a spec-approval with no data at all', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), { gate: 'spec-approval', ticket: 'T1' }]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects non-array approved_assumptions', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash, { approved_assumptions: 'trust me' })]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('approved_assumptions')));
  });

  it('rejects an empty sources array (proves nothing was actually checked)', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash, { sources: [] })]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('sources')));
  });

  // rounds:0/questions:0/sources:[null] all satisfy pure type checks
  // (Number.isInteger(0) is true, [null] has length 1) — these tests pin
  // down that a spec-approval entry claiming zero interrogation activity,
  // or a null source name, is rejected.
  it('rejects zero rounds (a degenerate value proving no interrogation activity)', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash, { rounds: 0 })]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('rounds')));
  });

  it('rejects zero questions (a degenerate value proving no interrogation activity)', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash, { questions: 0 })]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('questions')));
  });

  it('rejects a sources array containing a non-string element (e.g. null)', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash, { sources: [null] })]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('sources')));
  });

  it('rejects a sources array containing an empty-string element', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash, { sources: ['parallax', ''] })]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('sources')));
  });

  it('validates the latest spec-approval, so a corrected re-approval heals a bad one', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [
      sl('T1', { specPath, hash }), pm('T1', { specPath, hash }),
      validApprovalFor(specPath, hash, { unresolved: 1 }),
      validApprovalFor(specPath, hash),
    ]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('rejects a rejected verdict, even with an otherwise-complete payload', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash, { verdict: 'rejected' })]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('verdict')));
  });

  it('rejects a missing verdict field', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    const approval = validApprovalFor(specPath, hash);
    delete approval.data.verdict;
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), approval]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('verdict')));
  });

  it('rejects an empty approver', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash, { approver: '' })]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('approver')));
  });

  it('rejects an approval not bound to a ticket — surfaces as missing spec-approval, not a data error, since an unbound entry never matches the ticket-scoped selector', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    const approval = validApprovalFor(specPath, hash);
    delete approval.ticket;
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), approval]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes('spec-approval'), JSON.stringify(result));
  });

  it('rejects an approval with no bound file', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    const approval = validApprovalFor(undefined, undefined);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), approval]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('exactly one spec file')));
  });

  it('rejects a spec_hash that does not match the actually-recorded file hash (a fabricated hash)', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash, { spec_hash: 'a-lie-of-a-hash' })]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('spec_hash')));
  });

  // Codex cross-model review round 4: Pi resolves its approval argument to
  // an ABSOLUTE path before recording, while the documented spec-lint/
  // premortem CLI invocations pass through whatever spelling (often
  // relative) the caller typed — the same file, two legitimate spellings.
  it('accepts a spec-lint/premortem audit recorded under a RELATIVE path matching an approval recorded under the ABSOLUTE path to the same file', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    const relativePath = 'spec.md'; // resolves to the same file as specPath, given cwd: dir below
    writeManifest(dir, [
      sl('T1', { specPath: relativePath, hash }),
      pm('T1', { specPath: relativePath, hash }),
      validApprovalFor(specPath, hash), // absolute, as Pi records it
    ]);
    const result = assertPhase('p1', { dir, ticket: 'T1', cwd: dir });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('rejects a stale approval — the spec file changed after approval was recorded', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), validApprovalFor(specPath, hash)]);
    writeFileSync(specPath, '# Spec\nEDITED after approval — a materially different spec.\n');
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('changed after approval')));
  });

  it('rejects an approval recorded before the latest spec-lint evidence for this ticket', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [
      pm('T1', { specPath, hash }),
      validApprovalFor(specPath, hash),
      sl('T1', { specPath, hash }),
    ]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('before the latest spec-lint')));
  });

  it('rejects an approval recorded before the latest premortem evidence for this ticket', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [
      sl('T1', { specPath, hash }),
      validApprovalFor(specPath, hash),
      pm('T1', { specPath, hash }),
    ]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('before the latest premortem')));
  });

  // Finding D (codex cross-model review, feat/p1-interrogation full-branch
  // pass): unscoped spec-lint/premortem matching let ticket T2's approval
  // borrow ticket T1's audits. Both p1 ticket-requirement and the
  // ticket-scoped ordering check exist specifically to close this.
  it('does not let one ticket\'s audits satisfy another ticket\'s approval (cross-ticket evidence reuse)', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir); // T1's audited spec
    const specPathB = join(dir, 'spec-b.md');
    writeFileSync(specPathB, '# Spec B\nacceptance criteria: `test -f spec-b.md`\n');
    const hashB = sha256(readFileSync(specPathB));
    const approvalB = validApprovalFor(specPathB, hashB);
    approvalB.ticket = 'T2';
    writeManifest(dir, [
      sl('T1', { specPath, hash }), pm('T1', { specPath, hash }), // T1 audited spec A
      approvalB, // T2 approves spec B, never audited
    ]);
    const result = assertPhase('p1', { dir, ticket: 'T2' });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(result.missing?.includes('spec-lint') || result.errors?.some((e) => e.includes('spec-lint')), JSON.stringify(result));
  });

  // Codex cross-model review round 2: ticket-scoping alone still let the SAME
  // ticket launder a stale/different spec — T1 could lint spec-A, then
  // approve an edited spec-A or an entirely different spec-B without
  // re-running spec-lint/premortem. Each audit's own --files binding must
  // name the exact (path, hash) the approval binds.
  it('rejects an approval when the latest spec-lint for this ticket audited a DIFFERENT spec file', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    const otherPath = join(dir, 'other.md');
    writeFileSync(otherPath, '# Other\n');
    const otherHash = sha256(readFileSync(otherPath));
    writeManifest(dir, [
      sl('T1', { specPath: otherPath, hash: otherHash }), // audited a DIFFERENT file
      pm('T1', { specPath, hash }),
      validApprovalFor(specPath, hash),
    ]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('spec-lint evidence for this ticket does not audit')));
  });

  it('rejects an approval when the latest spec-lint for this ticket audited the SAME path but a STALE hash (spec edited after linting, before approval)', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [
      sl('T1', { specPath, hash: 'a-stale-hash' }),
      pm('T1', { specPath, hash }),
      validApprovalFor(specPath, hash),
    ]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('spec-lint evidence for this ticket does not audit')));
  });

  it('rejects an approval when the latest premortem for this ticket analyzed a DIFFERENT spec file', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    const otherPath = join(dir, 'other.md');
    writeFileSync(otherPath, '# Other\n');
    const otherHash = sha256(readFileSync(otherPath));
    writeManifest(dir, [
      sl('T1', { specPath, hash }),
      pm('T1', { specPath: otherPath, hash: otherHash }), // analyzed a DIFFERENT file
      validApprovalFor(specPath, hash),
    ]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('premortem evidence for this ticket does not analyze')));
  });

  it('rejects an approval when the latest spec-lint for this ticket has no --files binding at all (a hand-crafted record)', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [
      sl('T1'), // no specPath/hash → no files binding
      pm('T1', { specPath, hash }),
      validApprovalFor(specPath, hash),
    ]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('spec-lint evidence for this ticket does not audit')));
  });

  it('rejects an approval when the latest spec-lint for this ticket is not verified:true (a hand-crafted, never-actually-run record)', () => {
    const dir = tmpAdlc();
    const { specPath, hash } = specFixture(dir);
    writeManifest(dir, [
      sl('T1', { specPath, hash, verified: false }),
      pm('T1', { specPath, hash }),
      validApprovalFor(specPath, hash),
    ]);
    const result = assertPhase('p1', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('not a verified')));
  });
});
