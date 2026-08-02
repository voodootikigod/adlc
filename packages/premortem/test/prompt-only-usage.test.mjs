// A --prompt-only verdict is evidence that a model call HAPPENED (#spend-shape).
//
// The call is real and often expensive — the operator's harness makes it while
// answering the prompt this gate printed. The tool cannot see its tokens, so it
// must say "a call happened, unmeasured" rather than record nothing that the
// aggregator can count. Driven through the real CLI into a real ledger, because
// the claim is about what lands on disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { aggregateSpend } from '../../gate-manifest/lib/spend.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'premortem.mjs');

const SPEC = `# Spec: a thing

## Acceptance Criteria
- AC1: it works, verified by \`node --test test/\`
`;

function runVerdict() {
  const dir = mkdtempSync(join(tmpdir(), 'premortem-usage-'));
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, SPEC, 'utf8');
  const res = spawnSync(process.execPath, [CLI, specPath, '--prompt-only', '--record-verdict', '-'], {
    cwd: dir, input: 'No failure modes found.\n', encoding: 'utf8',
  });
  const entries = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  return { dir, code: res.status, stderr: res.stderr, entries };
}

test('a prompt-only verdict records usageStatus "unreported" and NO usage key', () => {
  const { dir, code, stderr, entries } = runVerdict();
  try {
    assert.equal(code, 0, `expected exit 0, got ${code}\n${stderr}`);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.gate, 'premortem');
    assert.equal(entry.data.usageStatus, 'unreported');
    // Asserted by KEY ABSENCE, not by value: a zeroed usage object would book an
    // unmeasured call as a measured free one, which is the exact fabrication
    // T152's rule forbids.
    assert.equal('usage' in entry.data, false, 'no counters may be invented');
    assert.equal(entry.data.promptOnly, true, 'the existing marker is unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the recorded verdict is then COUNTED at P1 by aggregateSpend', () => {
  // The point of the status: before it, this ledger aggregated to nothing and
  // the operator was told "no recorded usage" after doing real P1 work.
  const { dir, entries } = runVerdict();
  try {
    const agg = aggregateSpend(entries);
    assert.ok(agg.byPhase.P1, 'premortem is a P1 gate and the call is visible there');
    assert.equal(agg.byPhase.P1.unmeasuredCalls, 1);
    assert.equal(agg.byPhase.P1.calls, 0, 'nothing was measured, so nothing is claimed to be');
    assert.equal(agg.byPhase.P1.inputTokens, 0);
    assert.equal(agg.unmeasuredCalls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
