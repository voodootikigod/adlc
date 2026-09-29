// The build-gate depth counter is hand-ported into three plugin hooks (they
// cannot import workspace packages at runtime). Every copy must count prose
// tool-log lines exactly as packages/build-gate/lib/depth-signal.mjs does,
// including indented and timestamped lines, or a deep session reads shallow
// in one harness and trips the hard band in another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countToolCalls as core } from '../../packages/build-gate/lib/depth-signal.mjs';
import { PROSE_CASES } from '../../packages/build-gate/test/fixtures/prose-tool-lines.mjs';
import { countToolCalls as codex } from '../../plugins/adlc-codex/hooks/adlc-build-gate.mjs';
import { countToolCalls as copilot } from '../../plugins/adlc-copilot/hooks/adlc-build-gate.mjs';
import { countToolCallsForBuildGate as claudeCode } from '../../plugins/adlc-claude-code/hooks/adlc-hook.mjs';

const COPIES = { codex, copilot, 'claude-code': claudeCode };

for (const [name, copy] of Object.entries(COPIES)) {
  test(`${name} hook counts prose tool-log lines exactly as build-gate does`, () => {
    for (const [label, text, expected] of PROSE_CASES) {
      assert.equal(core(text), expected, `core: ${label}`);
      assert.equal(copy(text), expected, `${name}: ${label}`);
    }
  });
}
