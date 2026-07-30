// Concern: T152 P5 packet usage path (operating-stack §8a) — the exactly-once
// carrier, retry idempotency, and the claimed/reported boundary.
//
// Every case drives the REAL producer: the `adlc-prosecute --input` CLI writing
// into a temp ledger, read back with the REAL aggregator. Hand-constructing
// manifest entries here would test the aggregator against a shape no producer
// must emit — the test-integrity failure T152's acceptance criteria name.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadFiltered } from '@adlc/gate-manifest/lib/show.mjs';
import { aggregateSpend } from '@adlc/gate-manifest/lib/spend.mjs';
import { sha256 } from '@adlc/core';
import { FIXTURE_REVISION, finding, gitRepo, killedFinding, reviewPacket, tmpAdlc, transcript } from './helpers.mjs';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

const USAGE = Object.freeze({ inputTokens: 900, outputTokens: 150, cachedTokens: 40, provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'mid' });

/**
 * Build a packet whose passes are supplied by the caller. Trust-root tiering is
 * working-tree-inclusive, so the CLI must run in a clean throwaway repo or the
 * ambient repo's dirtiness leaks into the verdict (see prosecute-cli.test.mjs).
 */
function packet(dir, passes, { prefix = 'review' } = {}) {
  return {
    provenance: {
      reviewer: 'fixture-reviewer',
      session: 'fixture-session',
      command: 'fixture review command',
      transcript: transcript(dir),
    },
    review_packet: reviewPacket(dir, { prefix }),
    no_findings_attestation: {
      reason: 'fixture reviewer found no candidates',
      method: 'review transcript audit',
      evidence: 'review.txt',
    },
    passes,
  };
}

const DRY_TAIL = [
  { lens: 'correctness', findings: [], dry_evidence: 'no findings in correctness pass' },
  { lens: 'tests', findings: [], dry_evidence: 'no findings in tests pass' },
  { lens: 'behavior', findings: [], dry_evidence: 'no findings in behavior pass' },
];

/** Run the CLI against an isolated clean repo; returns the parsed --json verdict. */
function prosecute(dir, inputPath, repo, { expectFailure = false } = {}) {
  const argv = [BIN, '--input', inputPath, '--ticket', 'T1', '--revision', FIXTURE_REVISION, '--base', 'HEAD', '--dir', dir, '--json'];
  try {
    return JSON.parse(execFileSync(process.execPath, argv, { cwd: repo.dir, encoding: 'utf8' }));
  } catch (err) {
    if (!expectFailure) throw err;
    return JSON.parse(err.stdout || '{}');
  }
}

/** Run the CLI and return stderr, where the non-fatal §8a diagnostics go. */
function runCapturingStderr(dir, inputPath, repo) {
  const argv = [BIN, '--input', inputPath, '--ticket', 'T1', '--revision', FIXTURE_REVISION, '--base', 'HEAD', '--dir', dir, '--json'];
  const res = spawnSync(process.execPath, argv, { cwd: repo.dir, encoding: 'utf8' });
  return res.stderr ?? '';
}

function cleanRepo() {
  const repo = gitRepo();
  writeFileSync(join(repo.dir, '.gitkeep'), '');
  repo.g('add', '-A');
  repo.g('commit', '-qm', 'base');
  return repo;
}

function entriesFor(dir) {
  return loadFiltered({ dir }).entries;
}

describe('P5 packet usage — the exactly-once carrier', () => {
  it('attaches usage to the pass-completed entry ONLY, as claimed, aggregating to exactly one call', () => {
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      // A finding-bearing pass emits pass-started + two finding entries +
      // pass-completed. If usage rode every entry, this pass alone would
      // aggregate to 4 calls and 4x the tokens.
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()], callId: 'call-1', usage: USAGE },
        ...DRY_TAIL,
      ])));

      const verdict = prosecute(dir, inputPath, repo);
      assert.equal(verdict.exitCode, 0);

      const entries = entriesFor(dir);
      const carriers = entries.filter((e) => e?.data?.usage !== undefined);
      assert.equal(carriers.length, 1, 'exactly one entry may carry usage per model call');
      assert.equal(carriers[0].type, 'p5-pass-completed', 'the pass-completed entry is the sole carrier');
      assert.equal(carriers[0].data.usageStatus, 'claimed', 'packet-supplied usage is CLAIMED, never reported');

      // The pass really did emit the multi-entry shape this AC guards against.
      const passEntries = entries.filter((e) => typeof e.type === 'string' && e.type.startsWith('p5-'));
      assert.ok(passEntries.length > 1, `precondition: the pass must emit several entries (got ${passEntries.length})`);

      // Exact numbers, not merely nonzero.
      const agg = aggregateSpend(entries);
      assert.equal(agg.total.calls, 1);
      assert.equal(agg.byPhase.P5.calls, 1);
      assert.equal(agg.byPhase.P5.inputTokens, 900);
      assert.equal(agg.byPhase.P5.outputTokens, 150);
      assert.equal(agg.byPhase.P5.cachedTokens, 40);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('records no usage key and usageStatus unreported when the packet supplies none', () => {
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()] },
        ...DRY_TAIL,
      ])));

      assert.equal(prosecute(dir, inputPath, repo).exitCode, 0);

      const completed = entriesFor(dir).filter((e) => e.type === 'p5-pass-completed');
      assert.ok(completed.length > 0);
      for (const entry of completed) {
        assert.equal(entry.data.usageStatus, 'unreported');
        assert.equal('usage' in entry.data, false, 'absent usage must stay absent — never a zeroed object');
      }
      assert.equal(aggregateSpend(entriesFor(dir)).total.calls, 0);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('P5 packet usage — retry idempotency', () => {
  it('re-running the SAME packet appends no second carrier: still exactly one call', () => {
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()], callId: 'call-1', usage: USAGE },
        ...DRY_TAIL,
      ])));

      assert.equal(prosecute(dir, inputPath, repo).exitCode, 0);
      const afterFirst = aggregateSpend(entriesFor(dir));
      assert.equal(afterFirst.total.calls, 1, 'precondition: the first run recorded exactly one call');

      // Operator rerun / crash recovery over an unchanged packet.
      assert.equal(prosecute(dir, inputPath, repo).exitCode, 0);

      const afterSecond = aggregateSpend(entriesFor(dir));
      assert.equal(afterSecond.total.calls, 1, 'a replay must not re-bank spend already on the ledger');
      assert.equal(afterSecond.byPhase.P5.inputTokens, 900, 'and must not double the counters');
      assert.equal(afterSecond.byPhase.P5.outputTokens, 150);

      // The replay still records — it just records a POINTER, not the counters.
      const replay = entriesFor(dir).filter((e) => e?.data?.usageReplayOf !== undefined);
      assert.equal(replay.length, 1);
      assert.equal(replay[0].data.usageStatus, 'claimed');
      assert.equal('usage' in replay[0].data, false, 'a replay carrier must not repeat the counters');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('rejects a replay whose usage CONTRADICTS the recorded carrier, naming both values', () => {
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()], callId: 'call-1', usage: USAGE },
        ...DRY_TAIL,
      ])));
      assert.equal(prosecute(dir, inputPath, repo).exitCode, 0);

      // Same callId, same revision, same packet — different spend. One of the
      // two is wrong, and silently keeping either would launder a bad number.
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()], callId: 'call-1', usage: { ...USAGE, outputTokens: 999 } },
        ...DRY_TAIL,
      ])));

      const verdict = prosecute(dir, inputPath, repo, { expectFailure: true });
      assert.equal(verdict.status, 'op-error');
      const message = (verdict.errors ?? []).join('\n');
      assert.match(message, /call-1/, 'the error must name the callId in conflict');
      assert.match(message, /150/, 'and the value already on the ledger');
      assert.match(message, /999/, 'and the value the replay now claims');

      // The rejected replay must not have banked anything.
      assert.equal(aggregateSpend(entriesFor(dir)).byPhase.P5.outputTokens, 150);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('P5 packet usage — validation and the claimed/reported boundary', () => {
  it('rejects a malformed usage block naming the offending field', () => {
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [finding()], usage: { ...USAGE, inputTokens: -1 } },
        ...DRY_TAIL,
      ])));

      const verdict = prosecute(dir, inputPath, repo, { expectFailure: true });
      assert.notEqual(verdict.exitCode, 0);
      const message = [...(verdict.errors ?? []), verdict.status ?? ''].join('\n');
      assert.match(message, /inputTokens/, 'the validation error must name the field');
      assert.match(message, /non-negative integer/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown usage field rather than silently dropping it', () => {
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [finding()], usage: { ...USAGE, reasoningTokens: 40 } },
        ...DRY_TAIL,
      ])));

      const verdict = prosecute(dir, inputPath, repo, { expectFailure: true });
      assert.notEqual(verdict.exitCode, 0);
      assert.match((verdict.errors ?? []).join('\n'), /reasoningTokens.*not a recognized usage field/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('NO packet can mint attested telemetry: a usageStatus of "reported" is never produced by this path', () => {
    // `reported` is reserved for usage an ADAPTER parsed out of its harness's
    // own machine-readable output. Shape validation cannot prove a provider
    // ever emitted these counters, so a packet claiming otherwise must not be
    // able to launder itself into attested telemetry — whether by supplying
    // the status directly or by any code path downstream.
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()], callId: 'call-1', usage: USAGE, usageStatus: 'reported' },
        ...DRY_TAIL,
      ])));

      const verdict = prosecute(dir, inputPath, repo, { expectFailure: true });
      // Either the packet field is refused outright, or it is ignored and the
      // carrier still records `claimed`. Both are acceptable; silently trusting
      // it is not. Measured against the real CLI this takes the DOWNGRADE
      // branch — the packet's `usageStatus` is ignored — so assert the carrier
      // positively says `claimed` rather than merely "not reported", which
      // would also pass on an absent status.
      if (verdict.exitCode === 0) {
        const carriers = entriesFor(dir).filter((e) => e?.data?.usage !== undefined);
        assert.equal(carriers.length, 1, 'precondition: the run recorded a carrier to inspect');
        assert.equal(carriers[0].data.usageStatus, 'claimed', 'a packet must never produce attested telemetry');
        for (const entry of entriesFor(dir)) {
          assert.notEqual(entry?.data?.usageStatus, 'reported', 'no entry anywhere may claim to be attested');
        }
      } else {
        assert.ok((verdict.errors ?? []).length > 0, 'a refusal must say why');
      }
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('P5 packet usage — a rejected packet is side-effect-free', () => {
  // adversarial-review CRITICAL (rollback). The manifest is append-only, so an
  // op-error returned from inside the pass loop cannot undo entries already
  // written. A stray `p5-finding-killed` is NOT inert: seedOpenFindingsFromManifest
  // consumes it on the next run and drops a previously verified finding, so a
  // REJECTED replay could retire a real finding and let a later dry pass approve.
  it('a conflicting replay appends NOTHING — no pass, finding, dry, or usage entry', () => {
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [finding({ id: 'F-KEEP' })], callId: 'call-1', usage: USAGE },
        ...DRY_TAIL,
      ])));
      // A VERIFIED finding leaves the gate blocking (exit 2) — that is the
      // point: it leaves F-KEEP OPEN on the ledger, which is what the rejected
      // replay would otherwise retire.
      prosecute(dir, inputPath, repo, { expectFailure: true });
      const before = entriesFor(dir);
      assert.ok(
        before.some((e) => e.type === 'p5-finding-verified' && e?.finding?.id === 'F-KEEP'),
        'precondition: the first run recorded F-KEEP as verified'
      );

      // Same callId, contradictory counters — AND a kill for the finding the
      // first run verified. If the kill lands despite the rejection, the next
      // run's seeded open findings lose F-KEEP.
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding({ id: 'F-KEEP' })], callId: 'call-1', usage: { ...USAGE, outputTokens: 999 } },
        ...DRY_TAIL,
      ])));
      const verdict = prosecute(dir, inputPath, repo, { expectFailure: true });
      assert.equal(verdict.status, 'op-error');

      const after = entriesFor(dir);
      assert.equal(after.length, before.length, 'a rejected packet must append no entries at all');
      assert.equal(
        after.filter((e) => e.type === 'p5-finding-killed' && e?.finding?.id === 'F-KEEP').length,
        0,
        'the rejected kill must not reach the ledger — it would retire a verified finding on the next run'
      );
      assert.equal(aggregateSpend(after).byPhase.P5.outputTokens, 150, 'and no spend is re-banked');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('rejects a packet that contradicts ITSELF on one callId, before writing anything', () => {
    // The per-pass check could never see this: the first of the two passes had
    // not been recorded yet when it ran.
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()], callId: 'dup', usage: USAGE },
        { lens: 'contract', findings: [killedFinding({ id: 'F2' })], callId: 'dup', usage: { ...USAGE, inputTokens: 1 } },
        ...DRY_TAIL,
      ])));

      const verdict = prosecute(dir, inputPath, repo, { expectFailure: true });
      assert.equal(verdict.status, 'op-error');
      assert.match((verdict.errors ?? []).join('\n'), /dup/);
      assert.equal(entriesFor(dir).length, 0, 'nothing was written before the contradiction was found');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('P5 packet usage — partial counters are unknown, not zero', () => {
  // adversarial-review MEDIUM. aggregateSpend coerces an absent counter with
  // `?? 0`, so accepting a partial block converts UNKNOWN spend into MEASURED
  // ZERO — the same collapse the no-fabrication rule forbids, and the standard
  // the P4 adapters already hold.
  for (const missing of ['inputTokens', 'outputTokens', 'cachedTokens']) {
    it(`rejects a usage block missing ${missing}`, () => {
      const dir = tmpAdlc();
      const repo = cleanRepo();
      try {
        const partial = { ...USAGE };
        delete partial[missing];
        const inputPath = join(dir, 'passes.json');
        writeFileSync(inputPath, JSON.stringify(packet(dir, [
          { lens: 'security', findings: [finding()], usage: partial },
          ...DRY_TAIL,
        ])));

        const verdict = prosecute(dir, inputPath, repo, { expectFailure: true });
        assert.notEqual(verdict.exitCode, 0);
        assert.match((verdict.errors ?? []).join('\n'), new RegExp(`${missing} is required`));
      } finally {
        rmSync(repo.dir, { recursive: true, force: true });
      }
    });
  }
});

describe('P5 packet usage — identity and diagnostics', () => {
  it('two DIFFERENT prompts over the same inputs record distinct calls, not a false replay', () => {
    // The review packet validates prompt_hash separately because the prompt is
    // part of what was reviewed. Keying identity on inputs_hash alone made a
    // revised prompt over the same diff collide with the original whenever a
    // caller reused a locally-scoped call id — silently suppressing the second
    // real call, or rejecting it as a contradictory replay.
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      // SHARED inputs, DIFFERENT prompt — the exact shape that used to collide.
      const inputsFile = join(dir, 'shared-inputs.txt');
      writeFileSync(inputsFile, 'reviewed input packet — shared across both runs\n');
      const inputsHash = sha256(readFileSync(inputsFile));
      const packetWithPrompt = (name, text) => {
        const promptFile = join(dir, name);
        writeFileSync(promptFile, text);
        return { prompt: promptFile, prompt_hash: sha256(readFileSync(promptFile)), inputs: inputsFile, inputs_hash: inputsHash, clean_worktree: FIXTURE_REVISION };
      };

      const inputPath = join(dir, 'passes.json');
      const build = (reviewPacketDoc, usage) => ({
        provenance: { reviewer: 'r', session: 's', command: 'c', transcript: transcript(dir) },
        review_packet: reviewPacketDoc,
        no_findings_attestation: { reason: 'r', method: 'm', evidence: 'review.txt' },
        passes: [{ lens: 'security', findings: [killedFinding()], callId: 'call-1', usage }, ...DRY_TAIL],
      });

      writeFileSync(inputPath, JSON.stringify(build(packetWithPrompt('p1.txt', 'review prompt A\n'), USAGE)));
      assert.equal(prosecute(dir, inputPath, repo).exitCode, 0);

      writeFileSync(inputPath, JSON.stringify(build(packetWithPrompt('p2.txt', 'review prompt B — revised security focus\n'), { ...USAGE, outputTokens: 777 })));
      const verdict = prosecute(dir, inputPath, repo, { expectFailure: true });
      assert.equal(verdict.exitCode, 0, 'a genuinely different prompt is a different call, not a conflict');

      const agg = aggregateSpend(entriesFor(dir));
      assert.equal(agg.total.calls, 2, 'both real calls are booked');
      assert.equal(agg.byPhase.P5.outputTokens, 150 + 777);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('warns when usage is recorded without a callId (the carrier is not retry-safe)', () => {
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()], usage: USAGE },   // no callId
        ...DRY_TAIL,
      ])));

      const stderr = runCapturingStderr(dir, inputPath, repo);
      assert.match(stderr, /warning:/);
      assert.match(stderr, /no callId/);
      assert.match(stderr, /retry-safe/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('stays silent when every usage-bearing pass carries a callId', () => {
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()], callId: 'call-1', usage: USAGE },
        ...DRY_TAIL,
      ])));
      assert.doesNotMatch(runCapturingStderr(dir, inputPath, repo), /no callId/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('P5 packet usage — a replay must match provenance, not just counters', () => {
  it('same counters but a DIFFERENT model is a conflict, not an idempotent replay', () => {
    // `model` is what pricing multiplies the counters by, so same-tokens-
    // different-model is a genuinely different charge. Accepting it as a replay
    // silently retained the FIRST label — blocking correction of a mislabeled
    // record and suppressing a real second call after a model change.
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()], callId: 'call-1', usage: USAGE },
        ...DRY_TAIL,
      ])));
      assert.equal(prosecute(dir, inputPath, repo).exitCode, 0);

      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()], callId: 'call-1', usage: { ...USAGE, model: 'anthropic/claude-opus-5' } },
        ...DRY_TAIL,
      ])));
      const verdict = prosecute(dir, inputPath, repo, { expectFailure: true });
      assert.equal(verdict.status, 'op-error', 'contradictory provenance must be refused');
      assert.match((verdict.errors ?? []).join('\n'), /call-1/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('a genuinely identical replay — counters AND provenance — is still idempotent', () => {
    const dir = tmpAdlc();
    const repo = cleanRepo();
    try {
      const inputPath = join(dir, 'passes.json');
      writeFileSync(inputPath, JSON.stringify(packet(dir, [
        { lens: 'security', findings: [killedFinding()], callId: 'call-1', usage: USAGE },
        ...DRY_TAIL,
      ])));
      assert.equal(prosecute(dir, inputPath, repo).exitCode, 0);
      assert.equal(prosecute(dir, inputPath, repo).exitCode, 0);
      assert.equal(aggregateSpend(entriesFor(dir)).total.calls, 1, 'the stricter comparison must not break real idempotency');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});
