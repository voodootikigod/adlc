// This hook's hand-ported depth counter must count prose tool-log lines exactly
// as packages/build-gate/lib/depth-signal.mjs does, including indented and
// timestamped lines, or a deep session reads shallow in this harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countToolCalls as core } from '../../../../packages/build-gate/lib/depth-signal.mjs';
import { PROSE_CASES } from '../../../../packages/build-gate/test/fixtures/prose-tool-lines.mjs';
import { countToolCalls as hook } from '../adlc-build-gate.mjs';

for (const [label, text, expected] of PROSE_CASES) {
  test(`prose tool-log line parity: ${label} → ${expected}`, () => {
    assert.equal(hook(text), expected);
    assert.equal(hook(text), core(text));
  });
}
