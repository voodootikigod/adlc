// Concern: revision-binding / staleness rejection.
//
// resolveRevision() (lib/run.mjs ~L180-184) pins prosecution evidence to a concrete revision.
// transcriptProof() (~L64-85) and reviewPacketProof() (~L106-121) both refuse to accept
// evidence that doesn't name that exact revision (`text.includes(revision)` and
// `packet.clean_worktree === revision`, respectively) -- so evidence collected against a stale
// or different revision must be rejected rather than silently accepted. And
// seedOpenFindingsFromManifest() (~L153-168) only reopens findings recorded `entry.revision ===
// revision`, so a stale finding recorded at one revision must not block a later, different
// revision from converging.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProsecution } from '../lib/run.mjs';
import { canonicalJson, resolveRevision, sha256 } from '@adlc/core';
import { FIXTURE_REVISION, finding, gitRepo, input, killedFinding, reviewPacket, tmpAdlc, transcript } from './helpers.mjs';

describe('revision binding: transcript and review-packet proofs', () => {
  it('requires a readable review transcript', () => {
    const dir = tmpAdlc();
    const result = runProsecution({
      provenance: {
        reviewer: 'fixture-reviewer',
        session: 'fixture-session',
        command: 'fixture review command',
        transcript: join(dir, 'missing.txt'),
      },
      review_packet: reviewPacket(dir),
      passes: [{ lens: 'security', findings: [], dry_evidence: 'none found' }],
    }, { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => error.includes('provenance.transcript cannot be read')));
  });

  it('requires the transcript to name the ticket and reviewed revision', () => {
    const dir = tmpAdlc();
    const reviewTranscript = join(dir, 'review.txt');
    writeFileSync(reviewTranscript, 'generic review transcript with enough bytes but no binding markers\n'.repeat(2));
    const result = runProsecution({
      provenance: {
        reviewer: 'fixture-reviewer',
        session: 'fixture-session',
        command: 'fixture review command',
        transcript: reviewTranscript,
      },
      review_packet: reviewPacket(dir),
      no_findings_attestation: {
        reason: 'fixture reviewer found no candidates',
        method: 'review transcript audit',
        evidence: 'review.txt',
      },
      passes: [
        { lens: 'security', findings: [killedFinding()] },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
        { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings' },
      ],
    }, { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => error.includes('provenance.transcript must reference ticket T1')));
  });

  it('does not bind a transcript to a ticket by substring', () => {
    const dir = tmpAdlc();
    const reviewTranscript = transcript(dir, { ticket: 'T10' });
    const result = runProsecution({
      provenance: {
        reviewer: 'fixture-reviewer',
        session: 'fixture-session',
        command: 'fixture review command',
        transcript: reviewTranscript,
      },
      review_packet: reviewPacket(dir),
      no_findings_attestation: {
        reason: 'fixture reviewer found no candidates',
        method: 'review transcript audit',
        evidence: 'review.txt',
      },
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }, { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => error.includes('provenance.transcript must reference ticket T1')));
  });

  it('rejects a transcript that names the ticket but was reviewed against a stale revision', () => {
    const dir = tmpAdlc();
    const staleTranscript = transcript(dir, { ticket: 'T1', revision: 'stale-revision' });
    const result = runProsecution({
      provenance: {
        reviewer: 'fixture-reviewer',
        session: 'fixture-session',
        command: 'fixture review command',
        transcript: staleTranscript,
      },
      review_packet: reviewPacket(dir, { revision: 'stale-revision' }),
      no_findings_attestation: {
        reason: 'fixture reviewer found no candidates',
        method: 'review transcript audit',
        evidence: 'review.txt',
      },
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
      // The reviewer's evidence is bound to 'stale-revision', but the code under review has
      // since moved on to FIXTURE_REVISION -- the stale evidence must not be accepted.
    }, { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => error.includes(`provenance.transcript must reference reviewed revision ${FIXTURE_REVISION}`)));
  });

  it('rejects a review packet whose clean_worktree names a different revision', () => {
    const dir = tmpAdlc();
    const staleRevision = 'stale-revision';
    const result = runProsecution(input(dir, {
      review_packet: reviewPacket(dir, { revision: staleRevision }),
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => error.includes(`review_packet.clean_worktree must equal reviewed revision ${FIXTURE_REVISION}`)));
  });

  it('requires review packet hashes to match the reviewed prompt and input artifacts', () => {
    const dir = tmpAdlc();
    const badPacket = reviewPacket(dir);
    badPacket.inputs_hash = '0'.repeat(64);
    const result = runProsecution(input(dir, {
      review_packet: badPacket,
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => error.includes('review_packet.inputs hash mismatch')));
  });

  it('rejects an in-worktree transcript path outside evidence directories', () => {
    const repo = gitRepo();
    try {
      writeFileSync(join(repo.dir, 'src.txt'), 'base\n');
      mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
      writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({
        tickets: [{ id: 'T1', title: 'Fixture ticket', scope: ['src/**'], rails: ['test/**'], edges: [] }],
      }));
      repo.g('add', '-A');
      repo.g('commit', '-qm', 'base');
      const sourceTranscript = join(repo.dir, 'src.txt');
      const revision = resolveRevision({ cwd: repo.dir, ignorePaths: [sourceTranscript] });
      writeFileSync(sourceTranscript, [
        'base',
        `ticket: T1 reviewed revision: ${revision}`,
        'review transcript fixture with enough detail to be accepted as evidence',
      ].join('\n'));

      const result = runProsecution({
        provenance: {
          reviewer: 'fixture-reviewer',
          session: 'fixture-session',
          command: 'fixture review command',
          transcript: 'src.txt',
        },
        review_packet: reviewPacket(join(repo.dir, '.adlc'), { revision }),
        no_findings_attestation: {
          reason: 'fixture reviewer found no candidates',
          method: 'review transcript audit',
          evidence: 'src.txt',
        },
        passes: [
          { lens: 'security', findings: [killedFinding()] },
          { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
          { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
          { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings' },
        ],
      }, { dir: join(repo.dir, '.adlc'), ticket: 'T1', cwd: repo.dir });

      assert.equal(result.exitCode, 1);
      assert.ok(result.errors.some((error) => error.includes('must live under .adlc/ or .omo/evidence/')));
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('revision binding: default resolution and ticket lookup', () => {
  it('allows default revision binding when the transcript is inside the worktree', () => {
    const repo = gitRepo();
    try {
      writeFileSync(join(repo.dir, 'src.txt'), 'base\n');
      mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
      writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({
        tickets: [{ id: 'T1', title: 'Fixture ticket', scope: ['src/**'], rails: ['test/**'], edges: [] }],
      }));
      repo.g('add', '-A');
      repo.g('commit', '-qm', 'base');
      mkdirSync(join(repo.dir, '.omo/evidence'), { recursive: true });
      const reviewTranscript = join(repo.dir, '.omo/evidence/p5-review.txt');
      const revision = resolveRevision({ cwd: repo.dir, ignorePaths: [reviewTranscript] });
      writeFileSync(reviewTranscript, [
        'ticket: T1',
        `reviewed revision: ${revision}`,
        'review transcript fixture with enough detail to be accepted as evidence',
        'review transcript fixture with enough detail to be accepted as evidence',
      ].join('\n'));

      const result = runProsecution({
        provenance: {
          reviewer: 'fixture-reviewer',
          session: 'fixture-session',
          command: 'fixture review command',
          transcript: '.omo/evidence/p5-review.txt',
        },
        review_packet: reviewPacket(join(repo.dir, '.omo/evidence'), { revision }),
        no_findings_attestation: {
          reason: 'fixture reviewer found no candidates',
          method: 'review transcript audit',
          evidence: '.omo/evidence/p5-review.txt',
        },
        passes: [
          { lens: 'security', findings: [killedFinding()] },
          { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
          { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
          { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings' },
        ],
      }, { dir: join(repo.dir, '.adlc'), ticket: 'T1', cwd: repo.dir });

      assert.equal(result.exitCode, 0);
      assert.equal(result.revision, revision);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('binds non-default prosecution evidence to the manifest-dir ticket file before root .adlc tickets', () => {
    const repo = gitRepo();
    try {
      writeFileSync(join(repo.dir, 'src.txt'), 'base\n');
      mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
      writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({
        tickets: [{ id: 'T1', title: 'root ticket', scope: ['root/**'], rails: ['root-test/**'], edges: [] }],
      }));
      repo.g('add', '-A');
      repo.g('commit', '-qm', 'base');
      const dir = join(repo.dir, '.review');
      mkdirSync(dir, { recursive: true });
      const activeTicket = { id: 'T1', title: 'active ticket', scope: ['src/**'], rails: ['test/**'], edges: [] };
      writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [activeTicket] }));
      mkdirSync(join(repo.dir, '.omo/evidence'), { recursive: true });
      const reviewTranscript = join(repo.dir, '.omo/evidence/p5-review.txt');
      const revision = resolveRevision({ cwd: repo.dir, ignorePaths: [reviewTranscript, join(dir, 'tickets.json')] });
      writeFileSync(reviewTranscript, [
        'ticket: T1',
        `reviewed revision: ${revision}`,
        'review transcript fixture with enough detail to be accepted as evidence',
        'review transcript fixture with enough detail to be accepted as evidence',
      ].join('\n'));

      const result = runProsecution({
        provenance: {
          reviewer: 'fixture-reviewer',
          session: 'fixture-session',
          command: 'fixture review command',
          transcript: '.omo/evidence/p5-review.txt',
        },
        review_packet: reviewPacket(join(repo.dir, '.omo/evidence'), { revision }),
        no_findings_attestation: {
          reason: 'fixture reviewer found no candidates',
          method: 'review transcript audit',
          evidence: '.omo/evidence/p5-review.txt',
        },
        passes: [
          { lens: 'security', findings: [], dry_evidence: 'no security findings' },
          { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
          { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
        ],
      }, { dir, ticket: 'T1', cwd: repo.dir });

      assert.equal(result.exitCode, 0);
      const complete = readFileSync(join(dir, 'manifest.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((entry) => entry.type === 'p5-complete');
      assert.equal(complete.ticketHash, sha256(canonicalJson(activeTicket)));
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('revision binding: manifest-seeded open findings are revision-scoped', () => {
  it('does not complete dry-only prosecution when a previous manifest finding at the same revision is unresolved', () => {
    const dir = tmpAdlc();
    const first = runProsecution(input(dir, {
      passes: [{ lens: 'security', findings: [finding()] }],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });
    assert.equal(first.exitCode, 2);

    const second = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(second.exitCode, 2);
    assert.equal(second.openFindings.length, 1);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.doesNotMatch(manifest, /"type":"p5-complete"/);
  });

  it('completes later prosecution when it kills a previous manifest finding before dry passes', () => {
    const dir = tmpAdlc();
    const first = runProsecution(input(dir, {
      passes: [{ lens: 'security', findings: [finding()] }],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });
    assert.equal(first.exitCode, 2);

    const second = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [killedFinding()] },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
        { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(second.exitCode, 0);
    assert.deepEqual(second.openFindings, []);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"type":"p5-complete"/);
  });

  it('does not let a finding recorded at a stale revision block a later prosecution at a new revision', () => {
    const dir = tmpAdlc();
    const staleRevision = 'stale-revision';
    // Use a separate scratch directory for the stale-revision fixture files so they don't
    // collide with (and get silently overwritten by) the default-revision fixtures the
    // `input()` helper below writes into the shared `dir` for the second prosecution.
    const staleEvidenceDir = mkdtempSync(join(tmpdir(), 'adlc-prosecute-stale-'));
    const first = runProsecution({
      provenance: {
        reviewer: 'fixture-reviewer',
        session: 'fixture-session',
        command: 'fixture review command',
        transcript: transcript(staleEvidenceDir, { revision: staleRevision }),
      },
      review_packet: reviewPacket(staleEvidenceDir, { revision: staleRevision }),
      passes: [{ lens: 'security', findings: [finding()] }],
    }, { dir, ticket: 'T1', revision: staleRevision });
    assert.equal(first.exitCode, 2);
    assert.equal(first.openFindings.length, 1);

    // A fresh revision (e.g. the branch moved on) should not inherit the stale revision's
    // unresolved finding: seedOpenFindingsFromManifest() only reseeds entries whose recorded
    // revision matches the revision being prosecuted now.
    const second = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(second.exitCode, 0);
    assert.deepEqual(second.openFindings, []);
  });
});
