// threshold-exact-values.test.mjs — pins the Phase 0 scan-budget constants
// (context-rot-threshold-calibration spec §1.2.2) to their exact calibrated
// values. packages/context-handoff/test/thresholds.test.mjs is a rail frozen
// by tickets T154/T156/T157 (packages/context-handoff/test/**/*.test.mjs),
// so this coverage lives here instead — see
// packages/context-handoff/adapter-test/recovery-exception.test.mjs for the
// same relocation pattern.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_ACTIVE_CONTEXT_BYTES, MAX_SCAN_WALL_MS } from '@adlc/context-handoff';

test('MAX_ACTIVE_CONTEXT_BYTES is exactly 8 MiB', () => {
  assert.equal(MAX_ACTIVE_CONTEXT_BYTES, 8 * 1024 * 1024);
});

test('MAX_SCAN_WALL_MS is exactly 500', () => {
  assert.equal(MAX_SCAN_WALL_MS, 500);
});
