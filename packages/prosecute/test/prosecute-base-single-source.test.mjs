// Concern: #365 R4/AC18 — base resolution is SINGLE-SOURCED across all three consumers of the
// reviewed revision: record-cross-model (WRITES the attestation), tier-check (CHECKS it, the CI
// trust-root gate), and runProsecution's own P5 flow (ALSO checks it, packages/prosecute/lib/
// run.mjs ~L324). All three funnel through resolveProsecutionRevision(), which resolves `base`
// exactly once per call rather than letting each consumer derive its own ref (`main` vs
// `origin/main` vs a merge-base would silently produce three different revisions and make an
// attestation recorded by one consumer invisible to another).
//
// This is an end-to-end, subprocess-level proof: each consumer is invoked as its OWN CLI
// subcommand, none is ever told the revision explicitly (no --revision anywhere below), and yet
// an attestation recorded by one consumer satisfies the other two.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256 } from '@adlc/core';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

process.env.ADLC_MANIFEST_KEY = 'test-base-single-source-signing-key';

function runBin(args, cwd, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

// A trust-root-tiered scratch repo: an enforcement-package file changes between `main` and
// `feat`, so every consumer below is on the crossModelRequired path — the one where a base
// mismatch would actually matter.
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-base-single-source-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({
    tickets: [{ id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [] }],
  }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 0;\n');
  g('add', '-A'); g('commit', '-qm', 'baseline');
  g('checkout', '-q', '-b', 'feat');
  mkdirSync(join(dir, 'packages', 'prosecute', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'prosecute', 'lib', 'x.mjs'), 'export const z = 1;\n');
  g('add', '-A'); g('commit', '-qm', 'trust-root change');
  return dir;
}

describe('#365 R4/AC18 — base resolution reaches all three consumers identically', () => {
  it('record-cross-model, tier-check and the main P5 flow independently derive the SAME revision from --base, never told it explicitly', () => {
    const dir = scratchRepo();
    try {
      // Consumer 1 (checks, no attestation yet): tier-check derives its own revision from
      // --base alone and surfaces it via --json, without ever being handed one.
      const before = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc', '--json'], dir);
      assert.equal(before.status, 2);
      const beforeJson = JSON.parse(before.stdout);
      assert.equal(beforeJson.trustRootTier, true);
      const revisionFromTierCheck = beforeJson.revision;
      assert.ok(revisionFromTierCheck, 'tier-check surfaces a resolved revision');

      // Consumer 2 (writes): record-cross-model derives its OWN revision from --base alone —
      // never given --revision — and records the attestation under whatever it computed.
      const rec = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--base', 'main', '--dir', '.adlc'], dir);
      assert.equal(rec.status, 0);

      // If record-cross-model's independent base resolution had diverged from tier-check's
      // (e.g. one resolved `main`, the other a merge-base), the attestation it just wrote would
      // bind to a DIFFERENT revision string and tier-check would still be unsatisfied.
      const after = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc', '--json'], dir);
      assert.equal(after.status, 0, 'tier-check must now be satisfied by the attestation record-cross-model wrote independently');
      assert.equal(JSON.parse(after.stdout).revision, revisionFromTierCheck, 'both consumers must resolve to the identical revision string');

      // Consumer 3 (also checks, from inside the P5 convergence flow itself, run.mjs:324):
      // a full P5 run, again with --base only and no --revision, must ALSO find the
      // attestation — proving runProsecution's internal resolveProsecutionRevision call
      // agrees with the other two rather than deriving a fourth, private notion of `base`.
      const inputPath = join(dir, 'passes.json');
      mkdirSync(join(dir, '.omo/evidence'), { recursive: true });
      const transcriptPath = join(dir, '.omo/evidence/review.txt');
      const promptPath = join(dir, '.omo/evidence/review-prompt.txt');
      const inputsPath = join(dir, '.omo/evidence/review-inputs.txt');
      writeFileSync(transcriptPath, [
        'ticket: T1',
        `reviewed revision: ${revisionFromTierCheck}`,
        'review transcript fixture with enough detail to be accepted as evidence',
        'review transcript fixture with enough detail to be accepted as evidence',
      ].join('\n'));
      writeFileSync(promptPath, `review prompt for ${revisionFromTierCheck}\n`);
      writeFileSync(inputsPath, `reviewed input packet for ${revisionFromTierCheck}\n`);
      writeFileSync(inputPath, JSON.stringify({
        provenance: {
          reviewer: 'fixture-reviewer',
          session: 'fixture-session',
          command: 'fixture review command',
          transcript: transcriptPath,
        },
        review_packet: {
          prompt: promptPath,
          prompt_hash: sha256(readFileSync(promptPath)),
          inputs: inputsPath,
          inputs_hash: sha256(readFileSync(inputsPath)),
          clean_worktree: revisionFromTierCheck,
        },
        no_findings_attestation: {
          reason: 'fixture reviewer found no candidates',
          method: 'review transcript audit',
          evidence: transcriptPath,
        },
        passes: [
          { lens: 'security', findings: [], dry_evidence: 'no security findings' },
          { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
          { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
        ],
      }));
      const p5 = runBin(['--input', inputPath, '--ticket', 'T1', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc', '--json'], dir);
      const p5Json = JSON.parse(p5.stdout);
      assert.equal(p5Json.exitCode, 0, `P5 run must find the SAME attestation the other two consumers agreed on: ${p5.stdout}${p5.stderr}`);
      assert.equal(p5Json.revision, revisionFromTierCheck, 'the P5 flow must resolve the identical revision too');
    } finally { cleanup(dir); }
  });
});
