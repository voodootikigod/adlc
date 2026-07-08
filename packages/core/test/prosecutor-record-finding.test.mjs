// Tests for recordFinding — the P5→P7 bridge that lands a CONFIRMED prosecution
// finding in the findings ledger so lesson-foundry can cluster it (closes the loop
// where subagent-path prosecution left no ledger trail).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordFinding } from '../lib/prosecutor.mjs';
import { readEntries } from '../lib/ledger.mjs';

const mkDir = () => mkdtempSync(join(tmpdir(), 'adlc-record-finding-'));

describe('recordFinding', () => {
  test('appends a finding in the foundry schema, readable via readEntries', () => {
    const dir = mkDir();
    try {
      const entry = recordFinding(
        { file: 'packages/x/lib/y.mjs', desc: 'gate skipped an operative marker in inert context', category: 'security', severity: 'high', line: 42 },
        dir
      );
      assert.equal(entry.tool, 'prosecutor');
      assert.equal(entry.file, 'packages/x/lib/y.mjs');
      assert.equal(entry.desc, 'gate skipped an operative marker in inert context');
      assert.equal(entry.category, 'security');
      assert.equal(entry.severity, 'high');
      assert.equal(entry.line, 42);
      assert.equal(entry.verdict, 'open'); // not 'killed' → foundry keeps it
      assert.ok(typeof entry.ts === 'string' && entry.ts.length > 0);

      const { entries, skipped } = readEntries('findings', dir);
      assert.equal(skipped.length, 0);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].desc, entry.desc);
      // The clustering key (desc) must be present and non-empty for lesson-foundry.
      assert.ok(entries[0].desc && entries[0].desc.trim().length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('defaults category=prosecution, verdict=open, severity=medium, line=1', () => {
    const dir = mkDir();
    try {
      const entry = recordFinding({ file: 'a/b.mjs', desc: 'a confirmed finding' }, dir);
      assert.equal(entry.category, 'prosecution');
      assert.equal(entry.verdict, 'open');
      assert.equal(entry.severity, 'medium');
      assert.equal(entry.line, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preserves an explicit killed verdict (a refuted finding foundry will filter)', () => {
    const dir = mkDir();
    try {
      const entry = recordFinding({ file: 'a/b.mjs', desc: 'refuted', verdict: 'killed' }, dir);
      assert.equal(entry.verdict, 'killed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('appends (does not overwrite) across multiple calls', () => {
    const dir = mkDir();
    try {
      recordFinding({ file: 'a.mjs', desc: 'first finding' }, dir);
      recordFinding({ file: 'b.mjs', desc: 'second finding' }, dir);
      const { entries } = readEntries('findings', dir);
      assert.equal(entries.length, 2);
      assert.deepEqual(entries.map((e) => e.desc), ['first finding', 'second finding']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // FAIL CLOSED: a malformed finding is an operator error, not a silent no-op —
  // a swallowed write would leave P7 starved exactly as the original gap did.
  test('throws on a missing/blank file (never silently drops the finding)', () => {
    const dir = mkDir();
    try {
      assert.throws(() => recordFinding({ desc: 'no file' }, dir), /file/i);
      assert.throws(() => recordFinding({ file: '   ', desc: 'blank file' }, dir), /file/i);
      assert.equal(readEntries('findings', dir).entries.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws on a missing/blank desc (desc is the clustering key)', () => {
    const dir = mkDir();
    try {
      assert.throws(() => recordFinding({ file: 'a.mjs' }, dir), /desc/i);
      assert.throws(() => recordFinding({ file: 'a.mjs', desc: '  ' }, dir), /desc/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws on a non-object finding', () => {
    const dir = mkDir();
    try {
      assert.throws(() => recordFinding(null, dir), /object/i);
      assert.throws(() => recordFinding('nope', dir), /object/i);
      assert.throws(() => recordFinding(['a'], dir), /object/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
