// P0/P1 gate assertions: p0 requires coldstart evidence, p1 requires a
// human spec-approval record with a valid interrogation summary
// (.adlc/specs/p0-p1-human-interrogation.md, design D4).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPhase } from '../lib/assertions.mjs';
import { appendManifestEntry as realAppendManifestEntry } from '@adlc/gate-manifest';

const appendManifestEntry = (entry, dir, opts = {}) => realAppendManifestEntry(entry, dir, { key: null, ...opts });

function tmpAdlc() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-runner-p0p1-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(dir, entries) {
  for (const entry of entries) appendManifestEntry(entry, dir);
}

const validApproval = {
  gate: 'spec-approval',
  data: {
    approver: 'human@example.com',
    rounds: 2,
    questions: 5,
    sources: ['coldstart', 'parallax'],
    unresolved: 0,
    approved_assumptions: [],
  },
};

describe('p0 gate', () => {
  it('fails without a coldstart record', () => {
    const dir = tmpAdlc();
    const result = assertPhase('p0', { dir });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['coldstart']);
  });

  it('passes with a coldstart record', () => {
    const dir = tmpAdlc();
    writeManifest(dir, [{ gate: 'coldstart', data: { gaps: [] } }]);
    const result = assertPhase('p0', { dir });
    assert.equal(result.ok, true);
  });
});

describe('p1 gate spec-approval requirement', () => {
  it('fails when spec-lint and premortem exist but no spec-approval', () => {
    const dir = tmpAdlc();
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes('spec-approval'));
  });

  it('passes with a valid spec-approval interrogation payload', () => {
    const dir = tmpAdlc();
    writeManifest(dir, [{ gate: 'spec-lint' }, { gate: 'premortem' }, validApproval]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('rejects a spec-approval with unresolved > 0', () => {
    const dir = tmpAdlc();
    writeManifest(dir, [
      { gate: 'spec-lint' },
      { gate: 'premortem' },
      { ...validApproval, data: { ...validApproval.data, unresolved: 2 } },
    ]);
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
    writeManifest(dir, [
      { gate: 'spec-lint' },
      { gate: 'premortem' },
      { ...validApproval, data: { ...validApproval.data, approved_assumptions: 'trust me' } },
    ]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('approved_assumptions')));
  });

  it('validates the latest spec-approval, so a corrected re-approval heals a bad one', () => {
    const dir = tmpAdlc();
    writeManifest(dir, [
      { gate: 'spec-lint' },
      { gate: 'premortem' },
      { ...validApproval, data: { ...validApproval.data, unresolved: 1 } },
      validApproval,
    ]);
    const result = assertPhase('p1', { dir });
    assert.equal(result.ok, true, JSON.stringify(result));
  });
});
