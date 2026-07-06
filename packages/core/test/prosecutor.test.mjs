// prosecutor.test.mjs — consolidated behavioral tests for the single P5
// prosecution implementation (T17). These are the shared cases that were
// duplicated across plugins/adlc-claude-code/lib/test/prosecutor.test.mjs and
// plugins/adlc-opencode/test/prosecutor.test.mjs; those per-plugin files are
// frozen characterization rails and keep passing against the re-export shims —
// this file is the canonical home for the behavior. Harness-specific checks
// (shipped agent frontmatter shapes) stay in the per-plugin files. Offline.
//
// Imports go through the ROOT export (../index.mjs), not lib/prosecutor.mjs
// directly, so the test also proves the @adlc/core surface the plugin shims
// re-export from actually carries the prosecutor symbols.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LENSES, VERIFIER, ALL_AGENTS, findingKey, dedupeFindings, survivesVerification, shouldContinue,
} from '../index.mjs';

// ---- registry ----
test('registry: 5 lenses + verifier, ids unique', () => {
  assert.equal(LENSES.length, 5);
  assert.equal(VERIFIER.agent, 'prosecutor-verifier');
  assert.equal(ALL_AGENTS.length, 6);
  assert.equal(new Set(ALL_AGENTS).size, 6);
  for (const k of ['correctness', 'security', 'contract', 'diff', 'tests']) {
    assert.ok(LENSES.some((l) => l.key === k), `${k} lens present`);
  }
});

test('registry: every lens has an agent id and a non-empty focus', () => {
  for (const l of [...LENSES, VERIFIER]) {
    assert.match(l.agent, /^prosecutor-/, `${l.key} agent id is prosecutor-*`);
    assert.ok(typeof l.focus === 'string' && l.focus.length > 0, `${l.key} has a focus`);
  }
});

// ---- dedupeFindings ----
test('dedupeFindings: collapses same file+line+title, keeps highest severity', () => {
  const findings = [
    { file: 'a.mjs', line_start: 10, line_end: 10, title: 'Null deref', severity: 'low' },
    { file: 'a.mjs', line_start: 10, line_end: 10, title: 'null  deref', severity: 'high' }, // dup (case/space)
    { file: 'b.mjs', line_start: 5, line_end: 5, title: 'Injection', severity: 'critical' },
  ];
  const out = dedupeFindings(findings);
  assert.equal(out.length, 2);
  const a = out.find((f) => f.file === 'a.mjs');
  assert.equal(a.severity, 'high'); // highest kept
});

test('dedupeFindings: null/empty input yields empty list', () => {
  assert.deepEqual(dedupeFindings(null), []);
  assert.deepEqual(dedupeFindings([]), []);
});

test('findingKey normalizes title whitespace + case', () => {
  assert.equal(
    findingKey({ file: 'x', line_start: 1, line_end: 2, title: '  Big   Bug ' }),
    findingKey({ file: 'x', line_start: 1, line_end: 2, title: 'big bug' }),
  );
});

test('findingKey treats different line ranges as distinct findings', () => {
  assert.notEqual(
    findingKey({ file: 'x', line_start: 1, line_end: 2, title: 'Bug' }),
    findingKey({ file: 'x', line_start: 3, line_end: 4, title: 'Bug' }),
  );
});

// ---- survivesVerification ----
test('survivesVerification: strict majority of real votes survives', () => {
  assert.equal(survivesVerification([{ real: true }, { real: true }, { real: false }]), true); // 2/3
  assert.equal(survivesVerification([{ real: true }, { real: false }]), false); // 1/2 not > 0.5
  assert.equal(survivesVerification([{ real: false }, { real: false }]), false);
});

test('survivesVerification: no valid votes → SURVIVES as unverified blocker (fail closed)', () => {
  // A verifier crash/timeout must NOT silently drop a finding in a pre-merge gate.
  assert.equal(survivesVerification([]), true);
  assert.equal(survivesVerification(null), true);
  assert.equal(survivesVerification([null, undefined]), true); // no valid votes
});

test('survivesVerification: mixed valid/invalid votes only count the valid ones', () => {
  // 1 real out of 1 valid vote (the null is discarded, not counted as a "no" vote).
  assert.equal(survivesVerification([{ real: true }, null]), true);
});

test('survivesVerification: truthy-but-malformed votes FAIL CLOSED (not counted as refutations)', () => {
  // The docstring promises fail-closed on absent/invalid verification, but a
  // truthy-malformed vote survives a plain filter(Boolean) and would otherwise
  // sit in the denominator as a non-real (refuting) vote — silently dropping a
  // real blocker on a partial parse, a timeout, or a cannot-decide `{real:null}`.
  // A vote is valid ONLY if `real` is a boolean; anything else is discarded, and
  // zero valid votes SURVIVES.
  assert.equal(survivesVerification([{}]), true, 'empty-object vote must not refute');
  assert.equal(survivesVerification([{ real: null }]), true, '{real:null} cannot-decide must not refute');
  assert.equal(survivesVerification([{ real: 'yes' }]), true, 'non-boolean real must not refute');
  assert.equal(survivesVerification([{ real: true }, {}]), true, 'a lone real confirm + a malformed vote survives');
  // A genuine refutation still works: one real:false, no valid confirms → dropped.
  assert.equal(survivesVerification([{ real: false }, {}]), false, 'a real refutation among malformed still refutes');
});

// ---- shouldContinue (loop until dry) ----
test('shouldContinue: resets dry streak on fresh findings, stops after maxDry empties', () => {
  let s = shouldContinue({ freshThisRound: 3, dryStreak: 1, maxDry: 2 });
  assert.deepEqual(s, { continue: true, dryStreak: 0 });
  s = shouldContinue({ freshThisRound: 0, dryStreak: 0, maxDry: 2 });
  assert.deepEqual(s, { continue: true, dryStreak: 1 });
  s = shouldContinue({ freshThisRound: 0, dryStreak: 1, maxDry: 2 });
  assert.deepEqual(s, { continue: false, dryStreak: 2 });
});

test('shouldContinue: two consecutive dry rounds from a cold start stop the loop', () => {
  let s = shouldContinue({ freshThisRound: 0, dryStreak: 0 });
  assert.deepEqual(s, { continue: true, dryStreak: 1 });
  s = shouldContinue({ freshThisRound: 0, dryStreak: s.dryStreak });
  assert.deepEqual(s, { continue: false, dryStreak: 2 });
});

// ---- severity ordering (mutation-hardening: a single SEV-map value shift in
// the decrement direction creates a tie/reorder between adjacent tiers that
// the single low-vs-high dedupe case above cannot detect) ----
test('dedupeFindings: every adjacent severity pair keeps the higher tier, in both input orders', () => {
  const pairs = [
    ['critical', 'high'],
    ['high', 'medium'],
    ['medium', 'low'],
  ];
  for (const [higher, lower] of pairs) {
    for (const input of [
      [{ file: 'x.mjs', line_start: 1, line_end: 1, title: 'T', severity: higher },
       { file: 'x.mjs', line_start: 1, line_end: 1, title: 'T', severity: lower }],
      [{ file: 'x.mjs', line_start: 1, line_end: 1, title: 'T', severity: lower },
       { file: 'x.mjs', line_start: 1, line_end: 1, title: 'T', severity: higher }],
    ]) {
      const out = dedupeFindings(input);
      assert.equal(out.length, 1, `${higher}/${lower} must dedupe to one`);
      assert.equal(out[0].severity, higher, `${higher} must beat ${lower} regardless of input order`);
    }
  }
});
