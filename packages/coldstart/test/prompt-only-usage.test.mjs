// A --prompt-only coldstart verdict is evidence a model call HAPPENED
// (#spend-shape). Same contract as the premortem twin: the harness makes a real
// call answering the printed audit, the tool cannot see its tokens, so it
// records "a call happened, unmeasured" rather than nothing countable.
//
// Driven through the real CLI into a real ledger, because the claim is about
// what lands on disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { aggregateSpend } from '../../gate-manifest/lib/spend.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'coldstart.mjs');

const TICKETS = {
  tickets: [
    {
      id: 'T-ONE',
      title: 'do the thing',
      category: 'feature',
      duration: 1,
      edges: [],
      scope: ['src/**'],
      body: '## What\n\nBuild it.\n\n## Acceptance criteria\n\n- It works, verified by `node --test test/`.\n',
    },
  ],
};

function runVerdict() {
  const dir = mkdtempSync(join(tmpdir(), 'coldstart-usage-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify(TICKETS, null, 2));
  const res = spawnSync(process.execPath, [CLI, 'T-ONE', '--prompt-only', '--record-verdict', '-'], {
    cwd: dir, input: '{"gaps": []}\n', encoding: 'utf8',
  });
  const manifest = join(dir, '.adlc', 'manifest.jsonl');
  const entries = readFileSync(manifest, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { dir, code: res.status, stderr: res.stderr, entries };
}

test('a prompt-only coldstart verdict records usageStatus "unreported" and NO usage key', () => {
  const { dir, code, stderr, entries } = runVerdict();
  try {
    assert.equal(code, 0, `expected exit 0, got ${code}\n${stderr}`);
    const entry = entries.find((e) => e.gate === 'coldstart');
    assert.ok(entry, `no coldstart entry recorded: ${JSON.stringify(entries)}`);
    assert.equal(entry.data.usageStatus, 'unreported');
    // Key ABSENCE, not value: a zeroed usage object would book an unmeasured
    // call as a measured free one — the fabrication T152's rule forbids.
    assert.equal('usage' in entry.data, false, 'no counters may be invented');
    assert.equal(entry.data.promptOnly, true, 'the existing marker is unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the recorded verdict is then COUNTED at P2 by aggregateSpend', () => {
  const { dir, entries } = runVerdict();
  try {
    const agg = aggregateSpend(entries);
    assert.ok(agg.byPhase.P2, 'coldstart is a P2 gate and the call is visible there');
    assert.equal(agg.byPhase.P2.unmeasuredCalls, 1);
    assert.equal(agg.byPhase.P2.calls, 0, 'nothing was measured, so nothing is claimed to be');
    assert.equal(agg.byPhase.P2.inputTokens, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
