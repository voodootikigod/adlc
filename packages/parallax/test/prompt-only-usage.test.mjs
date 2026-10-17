// A --prompt-only verdict is evidence that a model call HAPPENED (#spend-shape).
//
// The call is real and often expensive — the operator's harness makes it while
// answering the prompt this gate printed. The tool cannot see its tokens, so it
// must say "a call happened, unmeasured" rather than record nothing that the
// aggregator can count. Driven through the real CLI into a real ledger, because
// the claim is about what lands on disk.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { aggregateSpend } from '../../gate-manifest/lib/spend.mjs';
import { readVerdictSource as coreReadVerdictSource } from '@adlc/core';
import { recordVerdict, readVerdictSource } from '../lib/verdict.mjs';

// Every fixture the factories below mint; removed once this file's tests finish.
const fixtureDirs = new Set();
after(() => {
  for (const dir of fixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'parallax.mjs');

function runVerdictCLI() {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-usage-'));
  fixtureDirs.add(dir);
  const verdictPath = join(dir, 'verdict.txt');
  writeFileSync(verdictPath, 'No divergence found.\n', 'utf8');
  const res = spawnSync(process.execPath, [CLI, '--request', 'Add a login page', '--prompt-only', '--record-verdict', verdictPath, '--ticket', 'T1'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const entries = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  return { dir, code: res.status, stderr: res.stderr, entries };
}

test('recordVerdict writes usageStatus "unreported" and NO usage key to .adlc/manifest.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-unit-usage-'));
  fixtureDirs.add(dir);
  const adlcDir = join(dir, '.adlc');
  recordVerdict({
    ticket: 'T-UNIT',
    verdict: 'all good',
    extra: { mode: 'spec' },
    dir: adlcDir,
    key: null,
  });
  const manifestPath = join(adlcDir, 'manifest.jsonl');
  const entries = readFileSync(manifestPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(entries.length, 1);
  const [diskEntry] = entries;
  assert.equal(diskEntry.gate, 'parallax');
  assert.equal(diskEntry.ticket, 'T-UNIT');
  assert.equal(diskEntry.data.usageStatus, 'unreported');
  assert.equal('usage' in diskEntry.data, false, 'no counters may be invented');
  assert.equal(diskEntry.data.promptOnly, true);
  assert.equal(diskEntry.data.verdict, 'all good');
});

test('a prompt-only parallax CLI verdict records usageStatus "unreported" and NO usage key', () => {
  const { code, stderr, entries } = runVerdictCLI();
  assert.equal(code, 0, `expected exit 0, got ${code}\n${stderr}`);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.gate, 'parallax');
  assert.equal(entry.data.usageStatus, 'unreported');
  // Asserted by KEY ABSENCE, not by value: a zeroed usage object would book an
  // unmeasured call as a measured free one, which is the exact fabrication
  // T152's rule forbids.
  assert.equal('usage' in entry.data, false, 'no counters may be invented');
  assert.equal(entry.data.promptOnly, true, 'the existing marker is unchanged');
});

test('the recorded verdict is then COUNTED at P1 by aggregateSpend', () => {
  const { entries } = runVerdictCLI();
  const agg = aggregateSpend(entries);
  assert.ok(agg.byPhase.P1, 'parallax is a P1 gate and the call is visible there');
  assert.equal(agg.byPhase.P1.unmeasuredCalls, 1);
  assert.equal(agg.byPhase.P1.calls, 0, 'nothing was measured, so nothing is claimed to be');
  assert.equal(agg.byPhase.P1.inputTokens, 0);
  assert.equal(agg.unmeasuredCalls, 1);
});

test('recordVerdict and readVerdictSource unit contract: re-exports core and enforces immutability', () => {
  assert.equal(readVerdictSource, coreReadVerdictSource, 'readVerdictSource must match @adlc/core');

  const dir = mkdtempSync(join(tmpdir(), 'parallax-unit-contract-'));
  fixtureDirs.add(dir);
  const adlcDir = join(dir, '.adlc');

  const entry = recordVerdict({
    ticket: 'T-UNIT-1',
    verdict: 'honest verdict',
    extra: {
      promptOnly: false,
      usageStatus: 'measured',
      verdict: 'spoofed',
      customField: 'preserved',
    },
    dir: adlcDir,
    key: null,
  });

  const manifestPath = join(adlcDir, 'manifest.jsonl');
  const entries = readFileSync(manifestPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

  assert.equal(entries.length, 1);
  const [diskEntry] = entries;
  assert.equal(diskEntry.gate, 'parallax');
  assert.equal(diskEntry.ticket, 'T-UNIT-1');
  assert.equal(diskEntry.data.promptOnly, true, 'promptOnly cannot be overridden');
  assert.equal(diskEntry.data.usageStatus, 'unreported', 'usageStatus cannot be overridden');
  assert.equal(diskEntry.data.verdict, 'honest verdict', 'verdict cannot be overridden');
  assert.equal(diskEntry.data.customField, 'preserved', 'customField is preserved');
  assert.equal('usage' in diskEntry.data, false);
});
