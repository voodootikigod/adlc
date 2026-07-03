// test/override.test.mjs — the audited-override recording path (issue #48,
// item 3). Mirrors rails-guard/adlc-hook.mjs's recordBypass(): the override
// is written to .adlc/manifest.jsonl via @adlc/gate-manifest's own record()
// (so it is chain-linked exactly like every other manifest entry), and
// recording success/failure is reported truthfully (never assumed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordOverride } from '../lib/override.mjs';
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { verify } from '@adlc/gate-manifest/lib/verify.mjs';

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
    assert.equal(entry.gate, 'build-gate-bypass');
    assert.equal(entry.ticket, 'T9');
    assert.deepEqual(entry.data.signals, ['declared-risk-high']);
    assert.equal(entry.data.depth, 55);
    assert.equal(entry.data.sessionBytes, 300000);
    assert.equal(entry.data.reason, 'operator-invoked override');
    assert.ok(entry.ts);
    // Chain-linkage fields required by gate-manifest's verify() — the whole
    // point of this entry existing at all (issue #48 review finding).
    assert.equal(entry.seq, 1);
    assert.equal(entry.prev, null);
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
    // seq must keep incrementing and each prev must chain to the line before it.
    assert.equal(JSON.parse(lines[0]).seq, 1);
    assert.equal(JSON.parse(lines[1]).seq, 2);
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

test('gate-manifest verify() still passes after recordOverride appends to an existing chain (regression, issue #48 review)', () => {
  withTempDir((dir) => {
    const adlcDir = join(dir, '.adlc');
    // Seed a normal gate-manifest entry first, exactly like a real preflight run would.
    record({ gate: 'preflight', ticket: 'T1', rawData: undefined, rawFiles: undefined, dir: adlcDir });

    const ok = recordOverride({
      ticketId: 'T1',
      signals: ['declared-risk-high'],
      depth: 50,
      sessionBytes: 1000,
      reason: 'ADLC_BUILD_GATE_BYPASS=1',
      dir: adlcDir,
    });
    assert.equal(ok, true);

    const result = verify(adlcDir);
    assert.equal(result.valid, true, result.message);
    assert.equal(result.count, 2);
  });
});

test('gate-manifest verify() still passes after further entries are appended following recordOverride', () => {
  withTempDir((dir) => {
    const adlcDir = join(dir, '.adlc');
    recordOverride({ ticketId: 'T1', signals: [], depth: 50, sessionBytes: 1000, reason: 'bypass', dir: adlcDir });
    record({ gate: 'preflight', ticket: 'T2', rawData: undefined, rawFiles: undefined, dir: adlcDir });

    const result = verify(adlcDir);
    assert.equal(result.valid, true, result.message);
    assert.equal(result.count, 2);
  });
});
