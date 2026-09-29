// Quartermaster seats are routed from ledger priors. The ledger read is lenient
// (a malformed line is skipped), so the plan must report what was skipped:
// otherwise a dry-run and the live run it predicts dispatch on priors built
// from an unknown fraction of the evidence with no signal anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp as makeTmp } from '@adlc/core/test-kit';
import { planSeats, skippedLedgerNotice } from '../lib/quartermaster.mjs';

const REGISTRY = {
  version: 3,
  channels: {
    frontier: { adapter: 'claude-code', model: 'claude-opus-5', transport: 'subscription:anthropic-max', provider: 'anthropic' },
    'frontier-metered': { adapter: 'claude-code', model: 'claude-opus-5', transport: 'api:anthropic-batch', provider: 'anthropic' },
    mid: { adapter: 'opencode', model: 'zai/glm-5.2', transport: 'gateway:opencode-go', provider: 'zai' },
    cheap: { adapter: 'opencode', model: 'deepseek/v4-flash', transport: 'gateway:opencode-go', provider: 'deepseek' },
  },
  reviewerGroups: {
    'cross-model-routine': { quorum: 1, members: [{ adapter: 'opencode', model: 'qwen/qwen3.7-coder', transport: 'gateway:opencode-go', provider: 'alibaba' }] },
    'cross-model-trust-root': {
      quorum: 2,
      members: [
        { adapter: 'opencode', model: 'moonshot/kimi-k3', transport: 'gateway:opencode-go', provider: 'moonshot' },
        { adapter: 'codex', model: 'gpt-5.3-codex', transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
      ],
    },
  },
  modelProviders: {
    opencode: { 'zai/glm-5.2': 'zai', 'deepseek/v4-flash': 'deepseek', 'qwen/qwen3.7-coder': 'alibaba', 'moonshot/kimi-k3': 'moonshot' },
    'claude-code': { 'claude-opus-5': 'anthropic' },
    codex: { 'gpt-5.3-codex': 'openai' },
  },
};
const TICKETS = [{ id: 'T-ONE', title: 'one', category: 'feature', duration: 1, body: 'x', edges: [], rails: ['a/r.mjs'], scope: ['a/**'] }];
const REG = '/operator/quartermaster.json';

function plan(adlcDir, tickets = TICKETS) {
  return planSeats({
    tickets, repoDir: '/repo', adlcDir,
    env: { ADLC_QUARTERMASTER_REGISTRY: REG },
    exists: (p) => p === REG,
    readFile: (p) => { if (p !== REG) throw new Error(`unexpected read: ${p}`); return JSON.stringify(REGISTRY); },
  });
}

test('planSeats reports the malformed ledger lines its priors were built without', (t) => {
  const adlcDir = makeTmp(t, 'qm-ledger-');
  writeFileSync(join(adlcDir, 'manifest.jsonl'), `${JSON.stringify({ gate: 'build', ticket: 'T-X', tier: 'frontier', verdict: 'pass' })}\nnot json at all\n`);
  const planned = plan(adlcDir);
  assert.equal(planned.seats.size, 1, 'the ticket is still routed');
  assert.equal(planned.skippedLedger.length, 1, 'the garbage line is reported');
  assert.equal(planned.skippedLedger[0].line, 2);
});

test('a clean ledger, and a plan with no tickets, report nothing skipped', (t) => {
  const adlcDir = makeTmp(t, 'qm-ledger-');
  writeFileSync(join(adlcDir, 'manifest.jsonl'), `${JSON.stringify({ gate: 'build', ticket: 'T-X' })}\n`);
  assert.deepEqual(plan(adlcDir).skippedLedger, []);
  assert.deepEqual(plan(adlcDir, []).skippedLedger, []);
});

test('skippedLedgerNotice names the count and is silent when nothing was skipped', () => {
  assert.equal(skippedLedgerNotice([]), null);
  assert.equal(skippedLedgerNotice(undefined), null);
  const one = skippedLedgerNotice([{ segment: 'root', line: 2, error: 'x' }]);
  assert.match(one, /^warning: quartermaster: 1 malformed ledger line skipped/);
  assert.match(one, /root:2/);
  assert.match(skippedLedgerNotice([{ segment: 'root', line: 2 }, { segment: 'seg-a', line: null }]), /2 malformed ledger lines skipped.*root:2, seg-a/);
});
