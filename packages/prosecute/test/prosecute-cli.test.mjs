// Concern: bin/adlc-prosecute.mjs CLI wiring (subprocess-level smoke tests).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FIXTURE_REVISION, killedFinding, repoRoot, reviewPacket, tmpAdlc, transcript } from './helpers.mjs';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

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
    // --base HEAD makes `git diff HEAD...HEAD` empty -> non-trust-root -> the tier
    // gate stays off, so this test asserts P5 CONVERGENCE hermetically, independent
    // of whatever the ambient worktree branch happens to touch (T39).
    const out = execFileSync(process.execPath, [
      bin,
      '--input',
      inputPath,
      '--ticket',
      'T1',
      '--revision',
      FIXTURE_REVISION,
      '--base',
      'HEAD',
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
    // --base HEAD isolates this convergence assertion from ambient-branch tiering (T39).
    const out = execFileSync(process.execPath, [
      bin,
      '--input',
      'docs/examples/p5-passes.json',
      '--ticket',
      'T1',
      '--revision',
      'docs-example-revision',
      '--base',
      'HEAD',
      '--dir',
      dir,
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.exitCode, 0);
  });

  describe('--record-finding (P5 → P7 bridge)', () => {
    it('records one finding to <dir>/findings.jsonl in the foundry schema', () => {
      const dir = tmpAdlc();
      const out = execFileSync(process.execPath, [
        BIN, '--record-finding',
        '--file', 'packages/x/lib/y.mjs',
        '--desc', 'gate skipped an operative marker sitting in an inert display context',
        '--category', 'security',
        '--severity', 'high',
        '--line', '42',
        '--dir', dir,
        '--json',
      ], { encoding: 'utf8' });
      const entry = JSON.parse(out);
      assert.equal(entry.tool, 'prosecutor');
      assert.equal(entry.file, 'packages/x/lib/y.mjs');
      assert.equal(entry.category, 'security');
      assert.equal(entry.line, 42);
      assert.equal(entry.verdict, 'open');

      // Landed in the ledger lesson-foundry reads.
      const ledger = join(dir, 'findings.jsonl');
      assert.ok(existsSync(ledger));
      const rows = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].desc, 'gate skipped an operative marker sitting in an inert display context');
    });

    it('fails closed (exit 1) when --desc is missing — never a silent no-op', () => {
      const dir = tmpAdlc();
      let status = 0;
      try {
        execFileSync(process.execPath, [BIN, '--record-finding', '--file', 'a.mjs', '--dir', dir], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        status = err.status;
      }
      assert.equal(status, 1);
      assert.equal(existsSync(join(dir, 'findings.jsonl')), false, 'no ledger file should be written on a rejected finding');
    });

    it('fails closed (exit 1) on a non-positive --line', () => {
      const dir = tmpAdlc();
      let status = 0;
      try {
        execFileSync(process.execPath, [BIN, '--record-finding', '--file', 'a.mjs', '--desc', 'x', '--line', '0', '--dir', dir], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        status = err.status;
      }
      assert.equal(status, 1);
    });
  });
});
