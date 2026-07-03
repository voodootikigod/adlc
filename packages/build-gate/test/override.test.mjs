// test/override.test.mjs — the audited-override recording path (issue #48,
// item 3). Mirrors rails-guard/adlc-hook.mjs's recordBypass(): the override
// is written to .adlc/manifest.jsonl via @adlc/core's ledger, and recording
// success/failure is reported truthfully (never assumed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordOverride } from '../lib/override.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-build-gate-override-'));
  try {
    return fn(dir);
  } finally {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('recordOverride writes a build-gate-bypass entry to .adlc/manifest.jsonl and returns true', () => {
  withTempDir((dir) => {
    const ok = recordOverride({
      ticketId: 'T9',
      signals: ['declared-risk-high'],
      depth: 55,
      sessionBytes: 300000,
      reason: 'operator-invoked override',
      dir: join(dir, '.adlc'),
    });
    assert.equal(ok, true);
    const manifestPath = join(dir, '.adlc', 'manifest.jsonl');
    assert.ok(existsSync(manifestPath));
    const lines = readFileSync(manifestPath, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.type, 'build-gate-bypass');
    assert.equal(entry.ticket, 'T9');
    assert.deepEqual(entry.signals, ['declared-risk-high']);
    assert.equal(entry.depth, 55);
    assert.equal(entry.sessionBytes, 300000);
    assert.equal(entry.reason, 'operator-invoked override');
    assert.ok(entry.ts);
  });
});

test('recordOverride appends (does not clobber) a prior manifest entry', () => {
  withTempDir((dir) => {
    recordOverride({ ticketId: 'T1', signals: [], depth: 1, sessionBytes: 1, reason: 'first', dir: join(dir, '.adlc') });
    recordOverride({ ticketId: 'T2', signals: [], depth: 2, sessionBytes: 2, reason: 'second', dir: join(dir, '.adlc') });
    const lines = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).ticket, 'T1');
    assert.equal(JSON.parse(lines[1]).ticket, 'T2');
  });
});

test('recordOverride returns false (never throws) when the ledger directory cannot be written', () => {
  withTempDir((dir) => {
    const adlcDir = join(dir, '.adlc');
    // Make the parent read-only so mkdir/append fails; simulate an unwritable repo.
    chmodSync(dir, 0o500);
    let ok;
    assert.doesNotThrow(() => {
      ok = recordOverride({ ticketId: 'T1', signals: [], depth: 1, sessionBytes: 1, reason: 'x', dir: adlcDir });
    });
    assert.equal(ok, false);
  });
});
