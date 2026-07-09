// prosecutor.test.mjs — the deterministic P5 loop, driven with a SCRIPTED fake
// runner (no real pi subprocess spawns under `node --test`). Covers AC1–AC3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prosecute, parseFindings, parseVote, resolvePiBin } from '../lib/prosecutor.mjs';

const DIFF = '--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-old\n+new\n';
const TICKET = { id: 'T1', title: 'Test ticket' };

// A finding shaped like the lens contract (dedupe/findingKey read these fields).
function finding(over = {}) {
  return {
    severity: 'high',
    file: 'src/x.mjs',
    line_start: 3,
    line_end: 5,
    title: 'off-by-one in the loop bound',
    body: 'the guard uses <= where < is correct',
    evidence: '+new',
    recommendation: 'use <',
    ...over,
  };
}

// A runner distinguishing lens prompts from verifier prompts by their text.
// `lensScript(round)` returns findings text; `voteFor(finding)` returns a vote.
function scriptRunner({ lensByRound, vote = { real: true } }) {
  let round = 0;
  const calls = { lens: 0, verifier: 0 };
  return {
    calls,
    runLens: async (prompt) => {
      if (prompt.startsWith('You are an ADLC prosecution VERIFIER')) {
        calls.verifier += 1;
        const v = typeof vote === 'function' ? vote(prompt) : vote;
        return JSON.stringify(v);
      }
      // A lens prompt. Count one "round" boundary each time the correctness lens
      // (the first in LENSES) is asked — the pool may interleave, so key off the
      // lens focus text to advance the round exactly once per fan-out.
      calls.lens += 1;
      if (prompt.includes('logic errors')) round += 1;
      const findings = lensByRound(round, prompt);
      return JSON.stringify(findings ?? []);
    },
  };
}

test('AC1: one finding in round 1, converges, records the confirmed finding, counts rounds/dry-passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-pros-ac1-'));
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  try {
    const recorded = [];
    // Only the security lens (matches its focus text) reports, and only in round 1.
    const { runLens, calls } = scriptRunner({
      lensByRound: (round, prompt) =>
        round === 1 && prompt.includes('auth/trust boundaries') ? [finding()] : [],
      vote: { real: true },
    });

    const summary = await prosecute({
      diff: DIFF,
      ticket: TICKET,
      runLens,
      recordDir: adlc,
      record: (f, d) => { recorded.push({ f, d }); },
    });

    assert.equal(summary.verdict, 'FINDINGS');
    assert.equal(summary.findings.length, 1);
    assert.equal(summary.rounds, 3, 'maxDry=2 converges exactly at round 3 (r1 confirmed, r2+r3 dry)');
    assert.equal(summary.dryPasses, 2, 'two dry rounds after the productive first round');
    assert.equal(recorded.length, 1, 'exactly one confirmed finding recorded');
    assert.equal(recorded[0].f.file, 'src/x.mjs');
    assert.equal(recorded[0].f.verdict, 'confirmed');
    assert.ok(recorded[0].f.desc.includes('off-by-one'), 'desc derives from the finding title');
    assert.equal(recorded[0].d, adlc, 'recorded into the ticket ledger dir');
    assert.ok(calls.verifier >= 1, 'the verifier was consulted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F2: loop-until-dry converges BEFORE maxRounds — the shouldContinue break is load-bearing', async () => {
  // maxRounds is deliberately ABOVE the natural convergence point (3) so that a
  // regression disabling the dry-pass break would run all 5 rounds — spawning
  // extra fresh-context lens children undetected (P5 finding F2). Correct code
  // stops at round 3 (r1 confirmed, r2+r3 dry === maxDry).
  const dir = mkdtempSync(join(tmpdir(), 'pi-pros-f2-'));
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  try {
    const { runLens } = scriptRunner({
      lensByRound: (round, prompt) =>
        round === 1 && prompt.includes('auth/trust boundaries') ? [finding()] : [],
      vote: { real: true },
    });
    const summary = await prosecute({
      diff: DIFF,
      ticket: TICKET,
      runLens,
      recordDir: adlc,
      record: () => {},
      options: { maxRounds: 5, maxDry: 2 },
    });
    assert.equal(summary.rounds, 3, 'must converge at maxDry, not run to maxRounds=5');
    assert.equal(summary.dryPasses, 2);
    assert.equal(summary.verdict, 'FINDINGS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC1 (real recorder): the confirmed finding is appended to .adlc/findings.jsonl', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-pros-ledger-'));
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  try {
    const { runLens } = scriptRunner({
      lensByRound: (round, prompt) =>
        round === 1 && prompt.includes('logic errors') ? [finding({ title: 'ledger-write proof' })] : [],
    });
    const summary = await prosecute({ diff: DIFF, ticket: TICKET, runLens, recordDir: adlc });
    assert.equal(summary.findings.length, 1);
    const ledger = join(adlc, 'findings.jsonl');
    assert.ok(existsSync(ledger), 'findings.jsonl created by the default recorder');
    const lines = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.tool, 'prosecutor');
    assert.equal(entry.file, 'src/x.mjs');
    assert.ok(entry.desc.includes('ledger-write proof'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC2: a verifier-rejected finding is NOT recorded and does NOT reappear as new later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-pros-ac2-'));
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  try {
    const recorded = [];
    // The SAME finding is surfaced by the correctness lens in EVERY round.
    // The verifier rejects it. It must be recorded zero times and never counted
    // as a fresh confirmation, so the loop goes dry and converges.
    const { runLens, calls } = scriptRunner({
      lensByRound: (_round, prompt) => (prompt.includes('logic errors') ? [finding({ title: 'phantom bug' })] : []),
      vote: { real: false },
    });

    const summary = await prosecute({
      diff: DIFF,
      ticket: TICKET,
      runLens,
      recordDir: adlc,
      record: (f) => recorded.push(f),
    });

    assert.equal(summary.verdict, 'CLEAN', 'a refuted finding leaves the verdict clean');
    assert.equal(summary.findings.length, 0);
    assert.equal(recorded.length, 0, 'a rejected finding is never recorded');
    // The verifier is consulted for the finding in round 1 only: once it is in
    // `seen`, later rounds do not re-surface it as fresh, so no re-verification.
    assert.equal(calls.verifier, 1, 'the refuted finding is verified exactly once, not every round');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC3: a hung lens runner is timed out, marked degraded, and does NOT fail the loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-pros-ac3-'));
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  try {
    // The correctness lens hangs forever (ignores its abort signal); every other
    // lens returns []. With a short timeout the loop must abandon the hung lens,
    // record it degraded, and still converge to a verdict.
    const runLens = (prompt) =>
      new Promise((resolve) => {
        if (prompt.includes('logic errors')) return; // never resolves — hang
        resolve('[]');
      });

    const summary = await prosecute({
      diff: DIFF,
      ticket: TICKET,
      runLens,
      recordDir: adlc,
      options: { timeout: 40, maxRounds: 2, maxDry: 2 },
      record: () => {},
    });

    assert.equal(summary.verdict, 'CLEAN');
    assert.ok(summary.degradedLenses.length >= 1, 'the hung lens is reported as degraded');
    assert.ok(
      summary.degradedLenses.some((d) => d.lens === 'correctness' && /timed out/i.test(d.reason)),
      'the degraded entry names the lens and the timeout reason'
    );
    assert.equal(summary.rounds, 2, 'the loop still ran its rounds despite the hung lens');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('empty diff → zero lenses, zero children, CLEAN (the live-smoke fast path)', async () => {
  let called = false;
  const summary = await prosecute({
    diff: '   \n  ',
    ticket: TICKET,
    runLens: async () => { called = true; return '[]'; },
  });
  assert.equal(summary.verdict, 'CLEAN');
  assert.equal(summary.rounds, 0);
  assert.equal(called, false, 'no runner call for an empty diff');
});

test('parseFindings tolerates fences/objects and drops fileless entries', () => {
  assert.equal(parseFindings('garbage, no json').length, 0);
  assert.equal(parseFindings('```json\n[]\n```').length, 0);
  const one = parseFindings('```json\n[{"file":"a.ts","title":"x"}]\n```');
  assert.equal(one.length, 1);
  const wrapped = parseFindings('{"findings":[{"file":"b.ts"},{"nope":1}]}');
  assert.equal(wrapped.length, 1, 'fileless finding dropped');
});

test('parseVote only accepts a boolean real', () => {
  assert.deepEqual(parseVote('{"real": true}'), { real: true, reason: undefined });
  assert.deepEqual(parseVote('{"real": "yes"}'), {}, 'non-boolean real is an invalid vote');
  assert.deepEqual(parseVote('not json'), {});
});

test('resolvePiBin falls back to PATH when the local bin is absent', () => {
  assert.equal(resolvePiBin('/nonexistent-repo-root-xyz'), 'pi');
});
