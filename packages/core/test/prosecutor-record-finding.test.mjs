// Tests for recordFinding — the P5→P7 bridge that lands a CONFIRMED prosecution
// finding in the findings ledger so lesson-foundry can cluster it (closes the loop
// where subagent-path prosecution left no ledger trail).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordFinding } from '../lib/prosecutor.mjs';
import { readEntries, appendEntry } from '../lib/ledger.mjs';

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

  // The ledger is TRACKED in git (ADR 0014), so every description recorded here gets
  // committed. "Curated prose, never raw dumps or secrets" was documented but not
  // enforced — and an unenforced rule is not a boundary. These assert the direction of
  // the check so it cannot silently drift back to fail-open.
  describe('secret boundary on the committed ledger', () => {
    const reject = (desc, re) => {
      const dir = mkDir();
      try { assert.throws(() => recordFinding({ file: 'a.mjs', desc }, dir), re); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    };

    test('refuses descriptions carrying credential-shaped values', () => {
      reject('leaked AKIA1234567890ABCDEF in the config', /AWS access key/i);
      reject('token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa was committed', /GitHub token/i);
      reject('-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAK', /private key/i);
      reject('called with Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345', /bearer token/i);
      reject('config had password: hunter2supersecret', /inline credential/i);
    });

    test('refuses raw multi-line tool output', () => {
      reject('stack trace:\n  at foo (a.mjs:1)\n  at bar (b.mjs:2)', /single line of curated prose/i);
    });

    test('refuses a long hex-encoded secret ANYWHERE in the entry, but exempts sha-length hex citations', () => {
      const dir = mkDir();
      try {
        // A >40-char hex run is not a git sha — a hex-encoded key/hash placed in any
        // field (here `evidence`) must be caught, not exempted as "just hex".
        assert.throws(
          () => appendEntry('findings', { file: 'a.mjs', desc: 'ok prose', evidence: 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00' }, dir),
          /high-entropy token|key or secret/i,
        );
        // But findings legitimately cite a 40-char git sha and short hex ids.
        appendEntry('findings', { file: 'a.mjs', desc: 'regression in d344a3545b24ccbd43949c39725aa64cf0079899; cluster 0e1fce8347ae' }, dir);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('refuses a description long enough to be a dump', () => {
      reject('x'.repeat(601), /capped at/i);
    });

    test('refuses an oversized raw dump smuggled into a NON-desc field', () => {
      // desc is single-line + capped, but the ledger is committed and append-only, so a
      // 2MB payload in `evidence` (or any other field) permanently bloats history just the
      // same. The whole entry is bounded, not only desc.
      const dir = mkDir();
      try {
        assert.throws(
          () => appendEntry('findings', { file: 'a.mjs', desc: 'ok prose', evidence: 'x'.repeat(5000) }, dir),
          /bytes serialized|capped at 4000/i,
        );
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('refuses a many-line dump (log paste / diff hunk / stack trace) in a NON-desc field', () => {
      const dir = mkDir();
      try {
        // A 30-line log paste in `evidence`: small in bytes, but unmistakably a raw dump.
        const logPaste = Array.from({ length: 30 }, (_, i) => `  at frame ${i} (mod.mjs:${i})`).join('\n');
        assert.throws(
          () => appendEntry('findings', { file: 'a.mjs', desc: 'ok prose', evidence: logPaste }, dir),
          /spans \d+ lines|raw multi-line dump/i,
        );
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('still accepts a finding with a SHORT multi-line evidence quote', () => {
      // The bound must not reject a legitimately curated finding that quotes a couple of
      // lines of the offending code — only unbounded/dump-shaped payloads.
      const dir = mkDir();
      try {
        assert.doesNotThrow(() => appendEntry('findings', {
          file: 'a.mjs',
          desc: 'guard failed open on invalid input',
          evidence: 'if (ok) {\n  proceed();\n}',
        }, dir));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('the entry-size cap is enforced at the EXACT boundary (an entry one byte over is rejected)', () => {
      const dir = mkDir();
      try {
        const base = { file: 'a.mjs', desc: 'ok prose', evidence: '' };
        const overhead = JSON.stringify(base).length;
        const atLimit = { ...base, evidence: 'x'.repeat(4000 - overhead) };
        const overLimit = { ...base, evidence: 'x'.repeat(4001 - overhead) };
        assert.equal(JSON.stringify(atLimit).length, 4000, 'precondition: exactly at the cap');
        assert.equal(JSON.stringify(overLimit).length, 4001, 'precondition: one byte over');
        assert.doesNotThrow(() => appendEntry('findings', atLimit, dir), 'an entry exactly at the cap is accepted');
        assert.throws(() => appendEntry('findings', overLimit, dir), /bytes serialized|capped at 4000/, 'one byte over is rejected');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('refuses a non-finding entry that would crash the P7 pipeline', () => {
      // A bare null/scalar/array is valid JSON that passes a secret scan but breaks
      // loadFindings (it dereferences .verdict / clusters on .desc). The committed-
      // ledger boundary must reject it so CI cannot approve a pipeline-breaking ledger.
      const dir = mkDir();
      try {
        for (const bad of [null, 42, 'a string', [1, 2], { tool: 'x' }, { tool: 'x', desc: '' }]) {
          assert.throws(() => appendEntry('findings', bad, dir), /finding object|non-empty string `desc`/);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('still accepts ordinary curated prose describing a failure class', () => {
      const dir = mkDir();
      try {
        const entry = recordFinding({
          file: 'packages/core/lib/prosecutor.mjs',
          desc: 'survivesVerification used filter(Boolean), so a truthy-malformed vote stayed in the denominator and could silently drop a real blocker — the guard failed OPEN on invalid input',
        }, dir);
        assert.equal(entry.tool, 'prosecutor');
        assert.match(entry.desc, /failed OPEN/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
});
