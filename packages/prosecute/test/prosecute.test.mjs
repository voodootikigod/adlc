import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runProsecution } from '../lib/run.mjs';
import { canonicalJson, resolveRevision, sha256 } from '@adlc/core';

const FIXTURE_REVISION = 'fixture-revision';
const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);

function tmpAdlc() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-prosecute-'));
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({
    tickets: [
      { id: 'T1', title: 'Fixture ticket', scope: ['src/**'], rails: ['test/**'], edges: [] },
      { id: 'T10', title: 'Substring guard ticket', scope: ['src/**'], rails: ['test/**'], edges: [] },
    ],
  }));
  return dir;
}

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-prosecute-git-'));
  const g = (...args) => execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  return { dir, g };
}

function transcript(dir, { ticket = 'T1', revision = FIXTURE_REVISION } = {}) {
  const path = join(dir, 'review.txt');
  writeFileSync(path, [
    `ticket: ${ticket}`,
    `reviewed revision: ${revision}`,
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n'));
  return path;
}

function reviewPacket(dir, { revision = FIXTURE_REVISION, prefix = 'review' } = {}) {
  const prompt = join(dir, `${prefix}-prompt.txt`);
  const inputs = join(dir, `${prefix}-inputs.txt`);
  writeFileSync(prompt, `review prompt for ${revision}\n`);
  writeFileSync(inputs, `reviewed input packet for ${revision}\n`);
  return {
    prompt,
    prompt_hash: sha256(readFileSync(prompt)),
    inputs,
    inputs_hash: sha256(readFileSync(inputs)),
    clean_worktree: revision,
  };
}

function finding(overrides = {}) {
  return {
    id: 'F1',
    severity: 'high',
    category: 'correctness',
    file: 'src/app.mjs',
    line_start: 1,
    line_end: 1,
    evidence: 'return false',
    claim: 'wrong result',
    recommendation: 'return true',
    confidence: 0.9,
    verified_status: 'verified',
    ...overrides,
  };
}

function input(dir, overrides = {}) {
  return {
    provenance: {
      reviewer: 'fixture-reviewer',
      session: 'fixture-session',
      command: 'fixture review command',
      transcript: transcript(dir),
    },
    review_packet: reviewPacket(dir),
    no_findings_attestation: {
      reason: 'fixture reviewer found no candidates',
      method: 'review transcript audit',
      evidence: 'review.txt',
    },
    ...overrides,
  };
}

describe('runProsecution', () => {
  it('passes after two consecutive dry passes and records p5-complete', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      target: 'fixture',
      passes: [
        {
          lens: 'security',
          findings: [finding({
            verified_status: 'killed',
            verification: {
              reason: 'fixture refuted',
              method: 'unit test',
              evidence: 'test passes',
            },
          })],
        },
        { lens: 'correctness', findings: [], dry_evidence: 'review transcript found no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'review transcript found no test findings' },
        { lens: 'behavior', findings: [], dry_evidence: 'review transcript found no behavior findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 0);
    assert.equal(result.revision, FIXTURE_REVISION);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"type":"p5-complete"/);
    assert.match(manifest, /"revision":"fixture-revision"/);
    assert.match(manifest, /"type":"p5-dry-pass"/);
  });

  it('passes a clean review with only dry passes and no finding candidates', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      target: 'fixture',
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.openFindings, []);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"type":"p5-complete"/);
  });

  it('fails when verified findings remain without two dry passes', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [{ lens: 'security', findings: [finding()] }],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.equal(result.openFindings.length, 1);
  });

  it('passes when a later killed disposition resolves an earlier verified finding', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [finding()] },
        {
          lens: 'security',
          findings: [finding({
            verified_status: 'killed',
            verification: {
              reason: 'fixture refuted',
              method: 'unit test',
              evidence: 'test passes',
            },
          })],
        },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
        { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.openFindings, []);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"type":"p5-finding-verified"/);
    assert.match(manifest, /"type":"p5-finding-killed"/);
    assert.match(manifest, /"type":"p5-complete"/);
  });

  it('does not count dry lenses from before a later finding toward final convergence', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings before later review work' },
        { lens: 'correctness', findings: [finding()] },
        {
          lens: 'correctness',
          findings: [finding({
            verified_status: 'killed',
            verification: {
              reason: 'fixture refuted',
              method: 'unit test',
              evidence: 'test passes',
            },
          })],
        },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings after refutation' },
        { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings after refutation' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.openFindings, []);
    assert.match(result.message, /fewer than three distinct dry lenses/);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.doesNotMatch(manifest, /"type":"p5-complete"/);
  });

  it('keeps a verified finding open when a killed disposition only shares the id', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [finding({ id: 'F1', claim: 'auth bypass' })] },
        {
          lens: 'security',
          findings: [finding({
            id: 'F1',
            claim: 'different claim',
            verified_status: 'killed',
            verification: {
              reason: 'fixture refuted',
              method: 'unit test',
              evidence: 'test passes',
            },
          })],
        },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
        { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.equal(result.openFindings.length, 1);
  });

  it('does not complete dry-only prosecution when a previous manifest finding is unresolved', () => {
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
        {
          lens: 'security',
          findings: [finding({
            verified_status: 'killed',
            verification: {
              reason: 'fixture refuted',
              method: 'unit test',
              evidence: 'test passes',
            },
          })],
        },
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

  it('does not complete when verified findings were seen before dry passes at the same revision', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [finding()] },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.equal(result.openFindings.length, 1);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.doesNotMatch(manifest, /"type":"p5-complete"/);
  });

  it('does not complete when verified findings appear after two dry passes', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [finding({ id: 'F2', category: 'test-integrity' })] },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.equal(result.openFindings.length, 1);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.doesNotMatch(manifest, /"type":"p5-complete"/);
  });

  it('does not count killed-only passes as dry', () => {
    const dir = tmpAdlc();
    const killed = {
      verified_status: 'killed',
      verification: {
        reason: 'fixture refuted',
        method: 'unit test',
        evidence: 'test passes',
      },
    };
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [finding({ ...killed, id: 'F1' })] },
        { lens: 'correctness', findings: [finding({ ...killed, id: 'F2', category: 'correctness' })] },
        { lens: 'tests', findings: [finding({ ...killed, id: 'F3', category: 'test-integrity' })] },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.equal(result.passes.every((pass) => pass.dry === false), true);
  });


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
        {
          lens: 'security',
          findings: [finding({
            verified_status: 'killed',
            verification: {
              reason: 'fixture refuted',
              method: 'unit test',
              evidence: 'test passes',
            },
          })],
        },
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
          {
            lens: 'security',
            findings: [finding({
              verified_status: 'killed',
              verification: {
                reason: 'fixture refuted',
                method: 'unit test',
                evidence: 'test passes',
              },
            })],
          },
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
          {
            lens: 'security',
            findings: [finding({
              verified_status: 'killed',
              verification: {
                reason: 'fixture refuted',
                method: 'unit test',
                evidence: 'test passes',
              },
            })],
          },
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
});

describe('adlc-prosecute cli', () => {
  it('exits 0 for two dry passes', () => {
    const dir = tmpAdlc();
    const input = join(dir, 'passes.json');
    const reviewTranscript = transcript(dir);
    writeFileSync(input, JSON.stringify({
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
        {
          lens: 'security',
          findings: [finding({
            verified_status: 'killed',
            verification: {
              reason: 'fixture refuted',
              method: 'unit test',
              evidence: 'test passes',
            },
          })],
        },
        { lens: 'correctness', findings: [], dry_evidence: 'no findings in correctness pass' },
        { lens: 'tests', findings: [], dry_evidence: 'no findings in tests pass' },
        { lens: 'behavior', findings: [], dry_evidence: 'no findings in behavior pass' },
      ],
    }));
    const bin = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [
      bin,
      '--input',
      input,
      '--ticket',
      'T1',
      '--revision',
      FIXTURE_REVISION,
      '--dir',
      dir,
      '--json',
    ], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.exitCode, 0);
  });

  it('accepts the bundled docs fixture from the repository root', () => {
    const dir = tmpAdlc();
    const bin = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [
      bin,
      '--input',
      'docs/examples/p5-passes.json',
      '--ticket',
      'T1',
      '--revision',
      'docs-example-revision',
      '--dir',
      dir,
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.exitCode, 0);
  });
});
