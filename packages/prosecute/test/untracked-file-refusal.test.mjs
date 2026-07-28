// Concern: #365 Decision 2 / AC15 — prosecution refuses to attest while an untracked-and-NOT-
// ignored file is present in the working tree, decided from RUNTIME-VERIFIABLE STATE ("is such a
// file present right now") rather than inferred by comparing digests (the #364 AC5 defect this
// criterion deliberately avoids repeating).
//
// Two load-bearing properties, both from the ticket's own wording:
//   (a) one untracked, non-ignored file present -> refused, the message names the offending path.
//   (b) a tree whose ONLY untracked files are GITIGNORED -> NOT refused. This is the scoping half:
//       node_modules is gitignored and always present, so a check that fires on ignored files
//       would brick prosecution permanently.
//
// The refusal is skipped when --revision/`revision` is EXPLICIT (see the comment in
// runProsecution / record-cross-model): an explicit revision isn't auto-resolved from the tree at
// all, so the rationale (identity silently disagreeing with what was executed) does not apply.
// That interaction is pinned here too, since it is what keeps FIXTURE_REVISION-based tests
// elsewhere in this suite unaffected by this new check.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runProsecution } from '../lib/run.mjs';
import { resolveChangeSetRevision } from '@adlc/core';
import { gitRepo, reviewPacket } from './helpers.mjs';

function baseline(repo) {
  writeFileSync(join(repo.dir, 'src.txt'), 'base\n');
  mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
  writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({
    tickets: [{ id: 'T1', title: 'Fixture ticket', scope: ['src/**'], rails: ['test/**'], edges: [] }],
  }));
  repo.g('add', '-A');
  repo.g('commit', '-qm', 'baseline');
}

// A minimal, real P5 input that converges (2 consecutive dry passes, 3 distinct dry lenses),
// with its evidence written INSIDE the repo so a default (non-explicit) revision resolves and
// the transcript/review_packet correctly reference it — mirroring the working pattern in
// prosecute-revision-binding.test.mjs ("allows default revision binding...").
function convergingInput(repo) {
  mkdirSync(join(repo.dir, '.omo/evidence'), { recursive: true });
  const transcript = join(repo.dir, '.omo/evidence/p5-review.txt');
  const revision = resolveChangeSetRevision({ cwd: repo.dir, base: 'main', ignorePaths: [transcript] });
  writeFileSync(transcript, [
    'ticket: T1',
    `reviewed revision: ${revision}`,
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n'));
  return {
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
  };
}

describe('#365 Decision 2 / AC15 — untracked-file refusal', () => {
  it('refuses (op-error) when an untracked, non-ignored file is present, and names the path', () => {
    const repo = gitRepo();
    try {
      baseline(repo);
      writeFileSync(join(repo.dir, 'scratch-not-ignored.txt'), 'stray\n');

      const result = runProsecution(convergingInput(repo), { dir: join(repo.dir, '.adlc'), ticket: 'T1', cwd: repo.dir });

      assert.equal(result.exitCode, 1);
      assert.ok(
        result.errors.some((e) => e.includes('refusing to attest') && e.includes('scratch-not-ignored.txt')),
        `expected a refusal naming the offending path, got: ${JSON.stringify(result.errors)}`
      );
    } finally { rmSync(repo.dir, { recursive: true, force: true }); }
  });

  it('does NOT refuse when the only untracked files are GITIGNORED (node_modules must never brick this)', () => {
    const repo = gitRepo();
    try {
      baseline(repo);
      writeFileSync(join(repo.dir, '.gitignore'), 'node_modules/\n*.log\n');
      repo.g('add', '-A'); repo.g('commit', '-qm', 'add gitignore');
      mkdirSync(join(repo.dir, 'node_modules', 'some-dep'), { recursive: true });
      writeFileSync(join(repo.dir, 'node_modules', 'some-dep', 'index.js'), 'module.exports = {};\n');
      writeFileSync(join(repo.dir, 'debug.log'), 'noise\n');

      const result = runProsecution(convergingInput(repo), { dir: join(repo.dir, '.adlc'), ticket: 'T1', cwd: repo.dir });

      assert.equal(result.exitCode, 0, `gitignored untracked files must not trigger the refusal: ${JSON.stringify(result.errors)}`);
    } finally { rmSync(repo.dir, { recursive: true, force: true }); }
  });

  it('an EXPLICIT --revision skips the refusal entirely, even with an untracked file present', () => {
    const repo = gitRepo();
    try {
      baseline(repo);
      writeFileSync(join(repo.dir, 'scratch-not-ignored.txt'), 'stray\n');

      const input = convergingInput(repo);
      const result = runProsecution(input, { dir: join(repo.dir, '.adlc'), ticket: 'T1', cwd: repo.dir, revision: 'pinned-revision' });

      // Not gated by the untracked-file refusal — whatever else the result is, it must not name
      // the untracked path as a reason.
      assert.ok(
        !(result.errors ?? []).some((e) => e.includes('refusing to attest')),
        `an explicit revision must bypass the untracked-file refusal entirely: ${JSON.stringify(result.errors)}`
      );
    } finally { rmSync(repo.dir, { recursive: true, force: true }); }
  });
});
