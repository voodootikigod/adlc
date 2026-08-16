// recovery-tool-names.test.mjs — direct unit coverage for
// isRecoveryEligibleToolName's RECOVERY_TOOL_NAMES allowlist. The sibling
// pipeline test (build-gate-recovery-exception.test.mjs) only drives
// 'exec_command' through the full three-hook subprocess pipeline, so a
// gap in ANY of the other six allowlisted names — including the lowercase
// 'shell' entry, distinct from the capitalized 'Shell' — was invisible.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRecoveryEligibleToolName } from '../adlc-handoff-gate.mjs';

test('isRecoveryEligibleToolName recognizes every declared recovery tool name', () => {
  for (const name of ['exec_command', 'functions.exec_command', 'exec', 'Bash', 'bash', 'Shell', 'shell']) {
    assert.equal(isRecoveryEligibleToolName(name), true, `expected ${name} to be recovery-eligible`);
  }
});

test('isRecoveryEligibleToolName rejects an unlisted tool name', () => {
  assert.equal(isRecoveryEligibleToolName('apply_patch'), false);
  assert.equal(isRecoveryEligibleToolName('run_command'), false);
});
