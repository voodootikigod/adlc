// Concern: bin/adlc-prosecute.mjs CLI wiring (subprocess-level smoke tests).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FIXTURE_REVISION, killedFinding, repoRoot, reviewPacket, tmpAdlc, transcript } from './helpers.mjs';

describe('adlc-prosecute cli', () => {
  it('exits 0 for two dry passes', () => {
    const dir = tmpAdlc();
    const inputPath = join(dir, 'passes.json');
    const reviewTranscript = transcript(dir);
    writeFileSync(inputPath, JSON.stringify({
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
        { lens: 'correctness', findings: [], dry_evidence: 'no findings in correctness pass' },
        { lens: 'tests', findings: [], dry_evidence: 'no findings in tests pass' },
        { lens: 'behavior', findings: [], dry_evidence: 'no findings in behavior pass' },
      ],
    }));
    const bin = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [
      bin,
      '--input',
      inputPath,
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
