// The process exit code derived from a run summary. A QUARANTINED run must fail even
// when no ticket reached a terminal failed/blocked state — the crash-resume case where
// quarantine was persisted but the affected ticket is still 'merging'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runExitCode } from '../lib/run.mjs';

test('a clean run (all merged) exits 0', () => {
  assert.equal(runExitCode({ results: { T1: 'merged', T2: 'merged' }, contaminated: false }), 0);
});

test('a failed or blocked ticket exits 2', () => {
  assert.equal(runExitCode({ results: { T1: 'merged', T2: 'failed' } }), 2);
  assert.equal(runExitCode({ results: { T1: 'blocked' } }), 2);
});

test('a QUARANTINED run exits 2 even with only NONTERMINAL ticket states', () => {
  // The crash-resume gap: quarantine persisted, then the process died before the
  // ticket left 'merging'. Keying only on failed/blocked would report success.
  assert.equal(
    runExitCode({ results: { T1: 'merging' }, contaminated: true, contaminationReason: 'ungated merge on the branch' }),
    2,
    'a quarantined-no-work run is never a success',
  );
});

test('a QUARANTINED run exits 2 even if every ticket looks merged', () => {
  assert.equal(runExitCode({ results: { T1: 'merged' }, contaminated: true }), 2);
});
