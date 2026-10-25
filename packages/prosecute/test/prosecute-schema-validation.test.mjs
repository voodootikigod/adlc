// Concern: input/schema validation and ticket-definition binding (op-error path).
//
// validateInput() (lib/schema.mjs) and the ticket checks in runProsecution() (lib/run.mjs
// ~L178-186) run before any evidence is written -- a bad shape, a missing ticket, or a ticket
// with no matching definition in tickets.json must all short-circuit to status 'op-error'
// (exitCode 1) without touching the manifest.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProsecution } from '../lib/run.mjs';
import { FIXTURE_REVISION, finding, input, reviewPacket, tmpAdlc, transcript } from './helpers.mjs';

describe('input validation (op-error)', () => {
  it('returns op-error for invalid schema', () => {
    const result = runProsecution({ passes: [{ lens: 'x', findings: [{ id: 'bad' }] }] });
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.length > 0);
  });

  it('requires ticketed evidence', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [{ lens: 'security', findings: [], dry_evidence: 'none found' }],
    }));
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => error.includes('ticket is required')));
  });

  it('requires the ticket to be defined before recording P5 evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-prosecute-no-ticket-'));
    try {
      const result = runProsecution(input(dir, {
        passes: [
          { lens: 'security', findings: [], dry_evidence: 'no security findings' },
          { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
          { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
        ],
      }), { dir, ticket: 'T404', revision: FIXTURE_REVISION });
      assert.equal(result.exitCode, 1);
      assert.ok(result.errors.some((error) => error.includes('ticket definition not found for T404')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires an attestation when all passes are empty', () => {
    const dir = tmpAdlc();
    const reviewTranscript = transcript(dir);
    const result = runProsecution({
      provenance: {
        reviewer: 'fixture-reviewer',
        session: 'fixture-session',
        command: 'fixture review command',
        transcript: reviewTranscript,
      },
      review_packet: reviewPacket(dir),
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
      ],
    }, { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => error.includes('no_findings_attestation')));
  });

  it('rejects deferred status when severity is medium or higher', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        {
          lens: 'security',
          findings: [
            finding({
              id: 'F-MED',
              severity: 'medium',
              verified_status: 'deferred',
              follow_up: 'T-200',
              reason: 'attempted to defer medium finding',
            }),
          ],
        },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => error.includes('deferred status is only allowed for severity "low"')));
  });

  it('rejects deferred status without follow_up or reason', () => {
    const dir = tmpAdlc();
    const missingFollowUp = runProsecution(input(dir, {
      passes: [
        {
          lens: 'security',
          findings: [
            finding({
              id: 'F-NO-FOLLOWUP',
              severity: 'low',
              verified_status: 'deferred',
              reason: 'valid reason',
            }),
          ],
        },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(missingFollowUp.exitCode, 1);
    assert.ok(missingFollowUp.errors.some((error) => error.includes('follow_up must be a non-empty string when verified_status is deferred')));
    assert.equal(missingFollowUp.errors.some((error) => error.includes('reason must be a non-empty string when verified_status is deferred')), false);

    const missingReason = runProsecution(input(dir, {
      passes: [
        {
          lens: 'security',
          findings: [
            finding({
              id: 'F-NO-REASON',
              severity: 'low',
              verified_status: 'deferred',
              follow_up: 'https://github.com/example/repo/issues/42',
            }),
          ],
        },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(missingReason.exitCode, 1);
    assert.ok(missingReason.errors.some((error) => error.includes('reason must be a non-empty string when verified_status is deferred')));
    assert.equal(missingReason.errors.some((error) => error.includes('follow_up must be a non-empty string when verified_status is deferred')), false);
  });

  it('validates the README example document and example transcript, and rejects prose-only ticket mention (#891)', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const jsonMatch = readme.match(/```json\n([\s\S]*?)\n```/);
    const textMatch = readme.match(/```text\n([\s\S]*?)\n```/);
    assert.ok(jsonMatch, 'README must include a json example block');
    assert.ok(textMatch, 'README must include a text transcript example block');

    const dir = tmpAdlc();
    const rev = 'git-worktree:0123456789abcdef';
    const transcriptPath = join(dir, 'readme-transcript.txt');
    writeFileSync(transcriptPath, textMatch[1]);
    const pkt = reviewPacket(dir, { revision: rev });
    const doc = JSON.parse(jsonMatch[1]);
    doc.provenance.transcript = transcriptPath;
    doc.review_packet = pkt;

    const okRes = runProsecution(doc, { dir, ticket: 'T1', revision: rev, base: 'HEAD' });
    assert.equal(okRes.errors, undefined);
    assert.equal(okRes.exitCode, 2, 'example document records findings and exits 2 (not yet converged)');

    const proseTranscriptPath = join(dir, 'prose-transcript.txt');
    writeFileSync(
      proseTranscriptPath,
      textMatch[1].replace(/^\s*ticket\s*:\s*T1\s*$/m, 'Reviewed ticket T1 in prose without a key-value line.')
    );
    const badDoc = { ...doc, provenance: { ...doc.provenance, transcript: proseTranscriptPath } };
    const badRes = runProsecution(badDoc, { dir, ticket: 'T1', revision: rev, base: 'HEAD' });
    assert.equal(badRes.exitCode, 1);
    assert.ok(
      badRes.errors.some((e) => e.includes('provenance.transcript must reference ticket T1')),
      `expected provenance.transcript must reference ticket error, got: ${JSON.stringify(badRes.errors)}`
    );
  });
});
