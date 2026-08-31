import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { gatedClaude, CLAUDE_STDOUT_CAP } from '../lib/evidence.mjs';

const ctx = () => {
  const calls = [];
  return {
    calls,
    pinned: { claude: '/pinned/claude' },
    env: { base: { PATH: '/usr/bin' }, home: '/home/op' },
    spawn: async (req) => { calls.push(req); return { status: 0, stdout: '{"result":"ok"}', stderr: '' }; },
  };
};

export async function ac72_gatedClaudeStdoutCap() {
  const c = ctx();
  await gatedClaude(c, { prompt: 'p', cwd: '/wt', model: 'opus', label: 'claude coldstart' });
  assert.equal(c.calls.length, 1);
  // Exactly the constant, exactly 64 KiB — a stdoutCap that drifted even by one byte would
  // change what a truncated `claude -p` response looks like at the boundary (agy/mutation-gate,
  // 2026-08-31: CLAUDE_STDOUT_CAP had no test asserting its value).
  assert.equal(c.calls[0].stdoutCap, CLAUDE_STDOUT_CAP);
  assert.equal(CLAUDE_STDOUT_CAP, 64 * 1024);
}
test('AC72: gatedClaude spawns the pinned claude with stdoutCap exactly CLAUDE_STDOUT_CAP (64 KiB)', ac72_gatedClaudeStdoutCap);
