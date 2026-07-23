// Concern: bin/adlc-prosecute.mjs CLI wiring (subprocess-level smoke tests).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FIXTURE_REVISION, gitRepo, killedFinding, repoRoot, reviewPacket, tmpAdlc, transcript } from './helpers.mjs';

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
    // Trust-root tiering is WORKING-TREE-INCLUSIVE by design (see adlc-prosecute.mjs):
    // it diffs the repo at `cwd` against --base, uncommitted changes included, so an
    // uncommitted trust-root edit can't evade the gate. That means `--base HEAD` is
    // ONLY hermetic when `cwd` resolves to a clean repo — inheriting the real repo's
    // cwd made this test flake against ANY dirty working tree (e.g. a lockstep
    // version-bump mid-release, which necessarily touches every enforcement package's
    // package.json). Run in an isolated, freshly-committed throwaway repo instead, so
    // the diff is empty regardless of what the real ambient repo looks like.
    const repo = gitRepo();
    try {
      writeFileSync(join(repo.dir, '.gitkeep'), '');
      repo.g('add', '-A');
      repo.g('commit', '-qm', 'base');
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
      ], { cwd: repo.dir, encoding: 'utf8' });
      const parsed = JSON.parse(out);
      assert.equal(parsed.exitCode, 0);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('accepts the bundled docs fixture from the repository root', () => {
    const dir = tmpAdlc();
    const bin = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    // Isolated repo for the same WORKING-TREE-INCLUSIVE-tiering reason as above.
    // --input still points at the REAL bundled docs fixture via an absolute path
    // (read as-is, not cwd-resolved), but the transcript/review_packet paths INSIDE
    // that fixture are repo-relative and get resolved against `cwd` by run.mjs — so
    // that evidence must be mirrored into the isolated repo for this fixture to still
    // validate as it does for real.
    //
    // The repository's own ticket store is deliberately NOT mirrored. This used to
    // copy `.adlc/tickets.json` in, with a comment claiming the ticket lookup needed
    // it, but that was never true: `tmpAdlc()` seeds T1/T10 into `<dir>/tickets.json`
    // and run.mjs's ticketDefinitionHash() prefers that `--dir` store over `<cwd>/.adlc`,
    // so the mirrored copy was never read. It only ever mattered because `cpSync`
    // throws on a missing source — which is how it survived unnoticed until the store
    // migrated to the sharded backend and the copy started failing with ENOENT.
    const repo = gitRepo();
    try {
      mkdirSync(join(repo.dir, '.omo/evidence'), { recursive: true });
      cpSync(join(repoRoot, '.omo/evidence'), join(repo.dir, '.omo/evidence'), { recursive: true });
      repo.g('add', '-A');
      repo.g('commit', '-qm', 'base');
      const out = execFileSync(process.execPath, [
        bin,
        '--input',
        join(repoRoot, 'docs/examples/p5-passes.json'),
        '--ticket',
        'T1',
        '--revision',
        'docs-example-revision',
        '--base',
        'HEAD',
        '--dir',
        dir,
        '--json',
      ], { cwd: repo.dir, encoding: 'utf8' });
      const parsed = JSON.parse(out);
      assert.equal(parsed.exitCode, 0);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
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
