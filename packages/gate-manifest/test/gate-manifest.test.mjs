// gate-manifest tests — node:test, offline, no API keys, temp dirs cleaned up.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { record, buildEntry, parseData, parseFileList, readLastRawLine } from '../lib/record.mjs';
import { verify } from '../lib/verify.mjs';
import { loadFiltered, renderEntries } from '../lib/show.mjs';
import { buildAttest } from '../lib/attest.mjs';
import { sha256, ledgerPath } from '../../core/index.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'gate-manifest-test-'));
}

function cleanTmp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ── parseData ─────────────────────────────────────────────────────────────────

describe('parseData', () => {
  it('returns undefined for falsy input', () => {
    assert.equal(parseData(undefined), undefined);
    assert.equal(parseData(''), undefined);
    assert.equal(parseData(null), undefined);
  });

  it('parses valid JSON', () => {
    const result = parseData('{"foo":1}');
    assert.deepEqual(result, { foo: 1 });
  });

  it('throws on malformed JSON', () => {
    assert.throws(() => parseData('{bad json}'), /not valid JSON/);
  });
});

// ── parseFileList ─────────────────────────────────────────────────────────────

describe('parseFileList', () => {
  it('returns empty array for falsy input', () => {
    assert.deepEqual(parseFileList(undefined), []);
    assert.deepEqual(parseFileList(''), []);
  });

  it('splits comma-separated paths and trims whitespace', () => {
    assert.deepEqual(parseFileList('a.js, b.js,c.js'), ['a.js', 'b.js', 'c.js']);
  });

  it('filters empty segments', () => {
    assert.deepEqual(parseFileList('a,,b'), ['a', 'b']);
  });
});

// ── readLastRawLine ───────────────────────────────────────────────────────────

describe('readLastRawLine', () => {
  let dir;
  before(() => { dir = makeTmp(); });
  after(() => cleanTmp(dir));

  it('returns null for non-existent file', () => {
    assert.equal(readLastRawLine(join(dir, 'missing.jsonl')), null);
  });

  it('returns null for empty file', () => {
    const p = join(dir, 'empty.jsonl');
    writeFileSync(p, '');
    assert.equal(readLastRawLine(p), null);
  });

  it('returns last non-empty line', () => {
    const p = join(dir, 'lines.jsonl');
    writeFileSync(p, '{"a":1}\n{"b":2}\n');
    assert.equal(readLastRawLine(p), '{"b":2}');
  });
});

// ── buildEntry ────────────────────────────────────────────────────────────────

describe('buildEntry', () => {
  it('first entry has seq=1, prev=null', () => {
    const e = buildEntry({
      gate: 'test-gate',
      ticket: undefined,
      data: undefined,
      filePaths: [],
      prevRawLine: null,
      prevSeq: 0,
      ts: '2024-01-01T00:00:00.000Z',
    });
    assert.equal(e.seq, 1);
    assert.equal(e.prev, null);
    assert.equal(e.gate, 'test-gate');
    assert.equal(e.ts, '2024-01-01T00:00:00.000Z');
    assert.deepEqual(e.files, {});
  });

  it('second entry prev equals sha256 of first raw line', () => {
    const firstRaw = '{"seq":1,"gate":"g1","ts":"2024-01-01T00:00:00.000Z","files":{},"prev":null}';
    const e = buildEntry({
      gate: 'g2',
      ticket: undefined,
      data: undefined,
      filePaths: [],
      prevRawLine: firstRaw,
      prevSeq: 1,
      ts: '2024-01-02T00:00:00.000Z',
    });
    assert.equal(e.seq, 2);
    assert.equal(e.prev, sha256(firstRaw));
  });

  it('includes ticket and data when provided', () => {
    const e = buildEntry({
      gate: 'g',
      ticket: 'T-42',
      data: { model: 'sonnet' },
      filePaths: [],
      prevRawLine: null,
      prevSeq: 0,
      ts: '2024-01-01T00:00:00.000Z',
    });
    assert.equal(e.ticket, 'T-42');
    assert.deepEqual(e.data, { model: 'sonnet' });
  });

  it('hashes real files', () => {
    const dir = makeTmp();
    try {
      const fp = join(dir, 'a.txt');
      writeFileSync(fp, 'hello');
      const e = buildEntry({
        gate: 'g',
        ticket: undefined,
        data: undefined,
        filePaths: [fp],
        prevRawLine: null,
        prevSeq: 0,
        ts: '2024-01-01T00:00:00.000Z',
      });
      assert.equal(e.files[fp], sha256('hello'));
    } finally {
      cleanTmp(dir);
    }
  });

  it('missing file hashes to null', () => {
    const e = buildEntry({
      gate: 'g',
      ticket: undefined,
      data: undefined,
      filePaths: ['/no/such/file.txt'],
      prevRawLine: null,
      prevSeq: 0,
      ts: '2024-01-01T00:00:00.000Z',
    });
    assert.equal(e.files['/no/such/file.txt'], null);
  });
});

// ── record → verify round-trip ────────────────────────────────────────────────

describe('record → verify round-trip', () => {
  let dir;
  beforeEach(() => { dir = makeTmp(); });
  // Each test gets its own fresh dir; clean up after each
  // (node:test doesn't have afterEach, so we clean in each test's finally)

  it('single record produces valid chain', () => {
    try {
      record({ gate: 'build', dir });
      const r = verify(dir);
      assert.equal(r.valid, true);
      assert.equal(r.count, 1);
    } finally {
      cleanTmp(dir);
    }
  });

  it('three records produce valid chain with monotonic seq', () => {
    try {
      const e1 = record({ gate: 'plan', dir });
      const e2 = record({ gate: 'build', dir });
      const e3 = record({ gate: 'test', dir });
      assert.equal(e1.seq, 1);
      assert.equal(e2.seq, 2);
      assert.equal(e3.seq, 3);
      const r = verify(dir);
      assert.equal(r.valid, true);
      assert.equal(r.count, 3);
    } finally {
      cleanTmp(dir);
    }
  });

  it('empty ledger is valid', () => {
    try {
      const r = verify(dir);
      assert.equal(r.valid, true);
      assert.equal(r.message, 'empty manifest');
    } finally {
      cleanTmp(dir);
    }
  });

  it('record with ticket and data is stored and retrievable', () => {
    try {
      record({ gate: 'spec', ticket: 'T-1', rawData: '{"model":"haiku"}', dir });
      const { entries } = loadFiltered({ ticket: 'T-1', dir });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].ticket, 'T-1');
      assert.deepEqual(entries[0].data, { model: 'haiku' });
    } finally {
      cleanTmp(dir);
    }
  });
});

// ── tamper detection ──────────────────────────────────────────────────────────

describe('tamper detection', () => {
  it('tampered middle line → verify exit-2 path with correct seq', () => {
    const dir = makeTmp();
    try {
      record({ gate: 'g1', dir });
      record({ gate: 'g2', dir });
      record({ gate: 'g3', dir });

      // Tamper line 2 (middle): read raw, replace second line
      const lp = ledgerPath('manifest', dir);
      const raw = readFileSync(lp, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());
      // Alter second line content (but keep valid JSON so parse succeeds)
      const parsed = JSON.parse(lines[1]);
      parsed.gate = 'TAMPERED';
      lines[1] = JSON.stringify(parsed);
      writeFileSync(lp, lines.join('\n') + '\n');

      const r = verify(dir);
      assert.equal(r.valid, false);
      // Should break at seq 3 (line 3) since line 2 was changed → its hash differs
      assert.ok(r.break !== null, 'break should not be null');
      // The break is at line 3 (seq=3) because that entry's prev no longer
      // matches the hash of the tampered line 2
      assert.equal(r.break.seq, 3);
    } finally {
      cleanTmp(dir);
    }
  });

  it('tampered first entry prev field → verify detects it', () => {
    const dir = makeTmp();
    try {
      record({ gate: 'g1', dir });
      record({ gate: 'g2', dir });

      const lp = ledgerPath('manifest', dir);
      const raw = readFileSync(lp, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());
      const parsed = JSON.parse(lines[0]);
      parsed.prev = 'tampered-hash';
      lines[0] = JSON.stringify(parsed);
      writeFileSync(lp, lines.join('\n') + '\n');

      const r = verify(dir);
      assert.equal(r.valid, false);
      assert.ok(r.break !== null);
    } finally {
      cleanTmp(dir);
    }
  });
});

// ── show filtering ────────────────────────────────────────────────────────────

describe('show filtering', () => {
  let dir;
  before(() => {
    dir = makeTmp();
    record({ gate: 'spec', ticket: 'T-1', dir });
    record({ gate: 'build', ticket: 'T-2', dir });
    record({ gate: 'test', ticket: 'T-1', dir });
  });
  after(() => cleanTmp(dir));

  it('no filter returns all entries', () => {
    const { entries } = loadFiltered({ dir });
    assert.equal(entries.length, 3);
  });

  it('ticket filter returns only matching entries', () => {
    const { entries } = loadFiltered({ ticket: 'T-1', dir });
    assert.equal(entries.length, 2);
    assert.ok(entries.every(e => e.ticket === 'T-1'));
  });

  it('non-existent ticket returns empty', () => {
    const { entries } = loadFiltered({ ticket: 'T-99', dir });
    assert.equal(entries.length, 0);
  });
});

// ── renderEntries ─────────────────────────────────────────────────────────────

describe('renderEntries', () => {
  it('renders (no entries) for empty array', () => {
    const lines = renderEntries([]);
    assert.deepEqual(lines, ['(no entries)']);
  });

  it('renders seq/gate/ts for each entry', () => {
    const dir = makeTmp();
    try {
      record({ gate: 'my-gate', ticket: 'T-1', dir });
      const { entries } = loadFiltered({ dir });
      const lines = renderEntries(entries);
      const joined = lines.join('\n');
      assert.ok(joined.includes('gate=my-gate'));
      assert.ok(joined.includes('ticket: T-1'));
    } finally {
      cleanTmp(dir);
    }
  });
});

// ── attest rendering ──────────────────────────────────────────────────────────

describe('attest', () => {
  let dir;
  before(() => {
    dir = makeTmp();
    record({ gate: 'spec',  ticket: 'T-5', dir });
    record({ gate: 'build', ticket: 'T-5', rawData: '{"model":"haiku"}', dir });
  });
  after(() => cleanTmp(dir));

  it('produces markdown heading with ticket', () => {
    const md = buildAttest({ ticket: 'T-5', dir });
    assert.ok(md.includes('## Gate evidence for T-5'));
  });

  it('includes gate names in the table', () => {
    const md = buildAttest({ ticket: 'T-5', dir });
    assert.ok(md.includes('spec'));
    assert.ok(md.includes('build'));
  });

  it('includes chain status', () => {
    const md = buildAttest({ ticket: 'T-5', dir });
    assert.ok(md.includes('Chain status:'));
    assert.ok(md.includes('valid'));
  });

  it('marks chain as BROKEN when tampered', () => {
    const badDir = makeTmp();
    try {
      record({ gate: 'g1', dir: badDir });
      record({ gate: 'g2', dir: badDir });
      const lp = ledgerPath('manifest', badDir);
      const raw = readFileSync(lp, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());
      const parsed = JSON.parse(lines[0]);
      parsed.gate = 'tampered';
      lines[0] = JSON.stringify(parsed);
      writeFileSync(lp, lines.join('\n') + '\n');
      const md = buildAttest({ dir: badDir });
      assert.ok(md.includes('BROKEN'));
    } finally {
      cleanTmp(badDir);
    }
  });

  it('attest without ticket shows all entries', () => {
    const md = buildAttest({ dir });
    assert.ok(md.includes('## Gate evidence'));
    // Should show both entries (T-5 spec and T-5 build)
    assert.ok(md.includes('spec'));
    assert.ok(md.includes('build'));
  });
});

// ── --files hashing ───────────────────────────────────────────────────────────

describe('--files hashing', () => {
  let dir;
  let fileA, fileB;
  before(() => {
    dir = makeTmp();
    fileA = join(dir, 'fileA.txt');
    fileB = join(dir, 'fileB.txt');
    writeFileSync(fileA, 'content of A');
    writeFileSync(fileB, 'content of B');
  });
  after(() => cleanTmp(dir));

  it('hashes listed files and includes them in entry', () => {
    const ledgerDir = makeTmp();
    try {
      const e = record({ gate: 'hash-test', rawFiles: `${fileA},${fileB}`, dir: ledgerDir });
      assert.ok(e.files[fileA]);
      assert.ok(e.files[fileB]);
      assert.equal(e.files[fileA], sha256('content of A'));
      assert.equal(e.files[fileB], sha256('content of B'));
    } finally {
      cleanTmp(ledgerDir);
    }
  });
});

// ── malformed --data JSON → opError path (tested at library level) ────────────

describe('parseData malformed JSON', () => {
  it('throws with informative message', () => {
    assert.throws(
      () => parseData('{not valid json}'),
      (err) => {
        assert.ok(err.message.includes('not valid JSON'));
        return true;
      }
    );
  });
});

// ── seq increment verification ────────────────────────────────────────────────

describe('seq increments', () => {
  it('each record increments seq by 1', () => {
    const dir = makeTmp();
    try {
      const entries = [];
      for (let i = 0; i < 5; i++) {
        entries.push(record({ gate: `gate-${i}`, dir }));
      }
      for (let i = 0; i < 5; i++) {
        assert.equal(entries[i].seq, i + 1);
      }
    } finally {
      cleanTmp(dir);
    }
  });
});
