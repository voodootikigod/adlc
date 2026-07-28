// gate-manifest tests — node:test, offline, no API keys, temp dirs cleaned up.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { appendManifestEntry, record, buildEntry, parseData, parseFileList, readLastRawLine } from '../lib/record.mjs';
import { verify } from '../lib/verify.mjs';
import { loadFiltered, renderEntries } from '../lib/show.mjs';
import { buildAttest } from '../lib/attest.mjs';
import { canonicalEntryBytes, KEY_ENV, signEntry, verifyEntrySig } from '../lib/sign.mjs';
import { repairChain } from '../lib/repair.mjs';
import { sha256, ledgerPath } from '../../core/index.mjs';

// ── key env helper ─────────────────────────────────────────────────────────────
// Tests mutate process.env[ADLC_MANIFEST_KEY] (read by record/verify via
// sign.getKey). withKey sets it for the duration of fn and always restores,
// so signing tests stay isolated from one another and from the no-key tests.

function withKey(key, fn) {
  const prev = process.env[KEY_ENV];
  if (key === null) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = key;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prev;
  }
}

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

  it('chains top-level runner evidence after a gate record', () => {
    try {
      record({ gate: 'rails-bypass', dir });
      const evidence = appendManifestEntry({
        type: 'p5-complete',
        ticket: 'T-1',
        revision: 'git-worktree:abc',
      }, dir);
      assert.equal(evidence.seq, 2);
      assert.equal(evidence.gate, 'p5-complete');
      assert.equal(evidence.type, 'p5-complete');
      assert.equal(verify(dir).valid, true);
    } finally {
      cleanTmp(dir);
    }
  });

  it('refuses a payload that supplies any reserved chain field', () => {
    try {
      for (const field of ['seq', 'prev', 'sig', 'sigVersion', 'segment']) {
        assert.throws(
          () => appendManifestEntry({ type: 'p5-complete', [field]: 'x' }, dir),
          new RegExp(field),
          `payload supplying "${field}" must be refused`,
        );
      }
    } finally {
      cleanTmp(dir);
    }
  });

  it('signs every field of generalized evidence so last-entry tampering fails', () => {
    try {
      withKey('test-key', () => {
        record({ gate: 'rails-bypass', dir });
        appendManifestEntry({
          type: 'p5-complete',
          ticket: 'T-1',
          revision: 'git-worktree:abc',
        }, dir);
        assert.equal(verify(dir).valid, true);

        const lp = ledgerPath('manifest', dir);
        const lines = readFileSync(lp, 'utf8').trimEnd().split('\n');
        const last = JSON.parse(lines.at(-1));
        last.revision = 'git-worktree:tampered';
        lines[lines.length - 1] = JSON.stringify(last);
        writeFileSync(lp, `${lines.join('\n')}\n`);
        const result = verify(dir);
        assert.equal(result.valid, false);
        assert.equal(result.break.reason, 'signature invalid');
      });
    } finally {
      cleanTmp(dir);
    }
  });

  it('rejects appending to a legacy unchained tail', () => {
    try {
      writeFileSync(ledgerPath('manifest', dir), '{"type":"legacy"}\n');
      assert.throws(
        () => appendManifestEntry({ type: 'p5-complete' }, dir),
        /manifest chain is invalid/
      );
    } finally {
      cleanTmp(dir);
    }
  });

  // #378: appendManifestEntry's pre-append check is scoped the same way verify()
  // is — a signed entry followed by a later unsigned one (e.g. a prior append ran
  // without ADLC_MANIFEST_KEY after signing was already adopted) must refuse
  // further appends, not silently continue degrading provenance.
  it('rejects appending onto a chain where a signed entry is followed by an unsigned one', () => {
    try {
      withKey('test-key', () => {
        record({ gate: 'signed-1', dir });
      });
      withKey(null, () => {
        record({ gate: 'unsigned-after-adoption', dir });
      });
      withKey('test-key', () => {
        assert.throws(
          () => appendManifestEntry({ type: 'p5-complete' }, dir),
          /manifest chain is invalid.*unsigned entry/
        );
      });
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

describe('repairChain', () => {
  it('plans without writing, then preserves a backup and rechains mixed evidence', () => {
    const dir = makeTmp();
    try {
      record({ gate: 'rails-bypass', dir });
      const path = ledgerPath('manifest', dir);
      appendFileSync(path, '{"type":"p5-complete","ticket":"T-1"}\n');
      assert.equal(verify(dir).valid, false);

      const before = readFileSync(path, 'utf8');
      const plan = repairChain({ dir, reason: 'recorder interoperability defect' });
      assert.equal(plan.write, false);
      assert.equal(readFileSync(path, 'utf8'), before);

      const result = repairChain({ dir, reason: 'recorder interoperability defect', write: true });
      assert.equal(result.write, true);
      assert.equal(existsSync(result.backup), true);
      assert.equal(readFileSync(result.backup, 'utf8'), before);
      assert.equal(verify(dir).valid, true);
      const { entries } = loadFiltered({ dir });
      assert.equal(entries[1].type, 'p5-complete');
      assert.equal(entries.at(-1).type, 'manifest-chain-repair');
      assert.equal(entries.at(-1).originalHash, sha256(before));
    } finally {
      cleanTmp(dir);
    }
  });

  it('re-signs every repaired entry when a manifest key is configured', () => {
    const dir = makeTmp();
    try {
      withKey('test-key', () => {
        record({ gate: 'rails-bypass', dir });
        appendFileSync(ledgerPath('manifest', dir), '{"type":"p5-complete"}\n');
        assert.throws(
          () => repairChain({ dir, reason: 'recorder interoperability defect', write: true }),
          /repair would cryptographically attest them/,
        );
        const repair = repairChain({
          dir,
          reason: 'recorder interoperability defect',
          write: true,
          attestUnsigned: true,
        });
        assert.equal(repair.newlySignedEntries, 1);
        assert.deepEqual(repair.newlySignedLines, [2]);
        const result = verify(dir);
        assert.equal(result.valid, true);
        assert.equal(result.signed, true);
        const { entries } = loadFiltered({ dir });
        assert.equal(entries.at(-1).newlySignedEntries, 1);
        assert.deepEqual(entries.at(-1).newlySignedLines, [2]);
      });
    } finally {
      cleanTmp(dir);
    }
  });

  it('rejects --attest-unsigned when no signing key is configured', () => {
    const dir = makeTmp();
    try {
      writeFileSync(ledgerPath('manifest', dir), '{"type":"p5-complete"}\n');
      withKey(null, () => {
        assert.throws(
          () => repairChain({
            dir,
            reason: 'recorder interoperability defect',
            attestUnsigned: true,
          }),
          /requires ADLC_MANIFEST_KEY/,
        );
      });
    } finally {
      cleanTmp(dir);
    }
  });

  it('CLI: a p6-accept record prints the ticket-completion reminder to stderr, a plain gate does not (T74)', () => {
    const dir = makeTmp();
    const bin = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;
    try {
      // p6-accept names a ticket → the bin must print the "you still have to complete it"
      // reminder on stderr (not stdout, so --json stays clean). Guards the `if (reminder)`
      // print branch: inverting it drops the reminder here.
      const accept = spawnSync(process.execPath, [bin, 'record', 'p6-accept', '--ticket', 'T9', '--dir', dir], { encoding: 'utf8' });
      assert.equal(accept.status, 0, accept.stderr);
      assert.match(accept.stderr, /adlc ticket complete T9 --write/, 'a p6-accept prints the completion reminder to stderr');
      // A non-acceptance gate prints NO reminder (the other side of the same guard).
      const plain = spawnSync(process.execPath, [bin, 'record', 'p4-gate', '--ticket', 'T9', '--dir', dir], { encoding: 'utf8' });
      assert.equal(plain.status, 0, plain.stderr);
      assert.doesNotMatch(plain.stderr, /ticket complete/, 'a non-acceptance gate prints no reminder');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // #378: proves --allow-legacy-unsigned is actually wired through parseArgs into
  // verify()'s requireSignatures option via the REAL binary (not just the library
  // function in isolation) — a reverted/typoed/negation-flipped flag would fail here.
  it('CLI: --allow-legacy-unsigned tolerates a legacy-unsigned-prefix manifest; omitting it still fails strict', () => {
    const dir = makeTmp();
    const bin = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;
    const env = { ...process.env, [KEY_ENV]: 'test-key' };
    try {
      withKey(null, () => {
        record({ gate: 'legacy-1', dir });
        record({ gate: 'legacy-2', dir });
      });
      withKey('test-key', () => {
        record({ gate: 'signed-1', dir });
      });

      const lenient = spawnSync(
        process.execPath,
        [bin, 'verify', '--json', '--allow-legacy-unsigned', '--dir', dir],
        { encoding: 'utf8', env },
      );
      assert.equal(lenient.status, 0, lenient.stdout + lenient.stderr);
      assert.equal(JSON.parse(lenient.stdout).valid, true);

      const strict = spawnSync(
        process.execPath,
        [bin, 'verify', '--json', '--dir', dir],
        { encoding: 'utf8', env },
      );
      assert.equal(strict.status, 2);
      const strictResult = JSON.parse(strict.stdout);
      assert.equal(strictResult.valid, false);
      assert.equal(strictResult.break.reason, 'unsigned entry');
    } finally {
      cleanTmp(dir);
    }
  });

  it('requires and audits explicit unsigned attestation through the CLI', () => {
    const dir = makeTmp();
    const bin = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;
    const env = { ...process.env, [KEY_ENV]: 'test-key' };
    try {
      withKey('test-key', () => record({ gate: 'rails-bypass', dir }));
      appendFileSync(ledgerPath('manifest', dir), '{"type":"p5-complete"}\n');
      const args = [
        bin,
        'repair-chain',
        '--dir', dir,
        '--reason', 'recorder interoperability defect',
        '--write',
        '--json',
      ];
      const refused = spawnSync(process.execPath, args, { encoding: 'utf8', env });
      assert.equal(refused.status, 1);
      assert.match(`${refused.stdout}${refused.stderr}`, /--attest-unsigned/);

      const accepted = spawnSync(
        process.execPath,
        [...args, '--attest-unsigned'],
        { encoding: 'utf8', env },
      );
      assert.equal(accepted.status, 0, accepted.stderr);
      const result = JSON.parse(accepted.stdout);
      assert.equal(result.newlySignedEntries, 1);
      assert.deepEqual(result.newlySignedLines, [2]);
    } finally {
      cleanTmp(dir);
    }
  });

  it('refuses to rewrite signed history under the wrong key', () => {
    const dir = makeTmp();
    try {
      withKey('original-key', () => record({ gate: 'rails-bypass', dir }));
      appendFileSync(ledgerPath('manifest', dir), '{"type":"p5-complete"}\n');
      withKey('wrong-key', () => {
        assert.throws(
          () => repairChain({ dir, reason: 'recorder interoperability defect', write: true }),
          /does not match ADLC_MANIFEST_KEY/,
        );
      });
    } finally {
      cleanTmp(dir);
    }
  });
});

// ── tamper detection ──────────────────────────────────────────────────────────

describe('tamper detection', () => {
  // These assert hash-chain behavior specifically; pin to no-key mode so the
  // break reason/seq is the prev-hash mismatch regardless of the runner's env
  // (with a key set, a stale signature would trip first).
  it('tampered middle line → verify exit-2 path with correct seq', () => {
    const dir = makeTmp();
    try {
      withKey(null, () => {
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
      });
    } finally {
      cleanTmp(dir);
    }
  });

  it('tampered first entry prev field → verify detects it', () => {
    const dir = makeTmp();
    try {
      withKey(null, () => {
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
      });
    } finally {
      cleanTmp(dir);
    }
  });

  it('rejects a first entry without a positive sequence number', () => {
    const dir = makeTmp();
    try {
      writeFileSync(ledgerPath('manifest', dir), '{"gate":"forged","prev":null}\n');
      const result = verify(dir);
      assert.equal(result.valid, false);
      assert.equal(result.break.reason, 'invalid seq');
    } finally {
      cleanTmp(dir);
    }
  });

  it('rejects a JSON value that is not an entry object', () => {
    const dir = makeTmp();
    try {
      writeFileSync(ledgerPath('manifest', dir), 'null\n');
      const result = verify(dir);
      assert.equal(result.valid, false);
      assert.equal(result.break.reason, 'entry must be an object');
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

// ── HMAC signing (keyed provenance) ───────────────────────────────────────────
// The hash chain alone is keyless: a writer can recompute every `prev` and
// forge a clean chain. These tests assert that with ADLC_MANIFEST_KEY set,
// only entries signed under the secret key verify — defeating that forgery.

const KEY = 'test-secret-key-do-not-ship';

describe('signing: signed record round-trip', () => {
  it('two signed records verify as valid AND signed', () => {
    const dir = makeTmp();
    try {
      withKey(KEY, () => {
        const e1 = record({ gate: 'plan', dir });
        const e2 = record({ gate: 'build', dir });
        // Every entry carries a 64-hex-char HMAC signature.
        assert.match(e1.sig, /^[0-9a-f]{64}$/);
        assert.match(e2.sig, /^[0-9a-f]{64}$/);
        const r = verify(dir);
        assert.equal(r.valid, true);
        assert.equal(r.signed, true);
        assert.equal(r.count, 2);
      });
    } finally {
      cleanTmp(dir);
    }
  });
});

describe('signing: forge-from-scratch attack is caught', () => {
  it('a hand-built chain with correct prev hashes but no key fails verify with key', () => {
    const dir = makeTmp();
    try {
      // Attacker (no key) forges a clean 2-entry chain from scratch: correct
      // prev hashes, valid seq, but NO signatures.
      const forged = withKey(null, () => {
        const e1 = buildEntry({
          gate: 'spec', ticket: 'T-1', data: undefined, filePaths: [],
          prevRawLine: null, prevSeq: 0, ts: '2024-01-01T00:00:00.000Z',
        });
        const line1 = JSON.stringify(e1);
        const e2 = buildEntry({
          gate: 'ship', ticket: 'T-1', data: undefined, filePaths: [],
          prevRawLine: line1, prevSeq: 1, ts: '2024-01-02T00:00:00.000Z',
        });
        const line2 = JSON.stringify(e2);
        return line1 + '\n' + line2 + '\n';
      });
      // Entries have no sig — this is the keyless forgery.
      assert.ok(!forged.includes('"sig"'));
      const lp = ledgerPath('manifest', dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(lp, forged);

      // The hash chain alone would accept this (sanity: no key → valid but unsigned).
      withKey(null, () => {
        const noKey = verify(dir);
        assert.equal(noKey.valid, true);
        assert.equal(noKey.signed, false);
      });

      // WITH the key, the forgery is rejected: unsigned entries fail.
      withKey(KEY, () => {
        const r = verify(dir);
        assert.equal(r.valid, false);
        assert.equal(r.signed, false);
        assert.equal(r.break.reason, 'unsigned entry');
        assert.equal(r.break.seq, 1);
      });
    } finally {
      cleanTmp(dir);
    }
  });
});

describe('signing: tamper after signing is caught', () => {
  it('editing a signed entry\'s data without re-signing → signature invalid', () => {
    const dir = makeTmp();
    try {
      withKey(KEY, () => {
        record({ gate: 'g1', rawData: '{"model":"haiku"}', dir });
        record({ gate: 'g2', dir });

        // Tamper the FIRST entry's data and recompute prev forward (so the
        // hash chain still links) but DO NOT re-sign.
        const lp = ledgerPath('manifest', dir);
        const lines = readFileSync(lp, 'utf8').split('\n').filter(l => l.trim());

        const e1 = JSON.parse(lines[0]);
        e1.data = { model: 'frontier' }; // tampered payload, stale sig
        lines[0] = JSON.stringify(e1);

        // Repair the hash chain so prev mismatch isn't what trips verify —
        // we want to prove the SIGNATURE catches this, not the hash chain.
        const e2 = JSON.parse(lines[1]);
        e2.prev = sha256(lines[0]);
        lines[1] = JSON.stringify(e2);
        writeFileSync(lp, lines.join('\n') + '\n');

        const r = verify(dir);
        assert.equal(r.valid, false);
        assert.equal(r.break.reason, 'signature invalid');
        assert.equal(r.break.seq, 1);
      });
    } finally {
      cleanTmp(dir);
    }
  });

  it('requireSignatures:false tolerates an UNSIGNED entry but still rejects a TAMPERED signature (#354 F1)', () => {
    const dir = makeTmp();
    try {
      // A manifest with a legitimately-unsigned legacy entry, then a signed one.
      withKey(null, () => record({ gate: 'legacy', dir })); // no key → unsigned
      withKey(KEY, () => record({ gate: 'signed', rawData: '{"v":1}', dir }));
      const lp = ledgerPath('manifest', dir);

      // Lenient mode accepts the mixed manifest: the unsigned legacy entry is tolerated
      // and the signed entry verifies.
      withKey(KEY, () => {
        const ok = verify(dir, { requireSignatures: false });
        assert.equal(ok.valid, true);
      });

      // Now TAMPER the signed entry's data (invalidating its sig) and repair the hash
      // chain forward so only the SIGNATURE — not the prev hash — could catch it.
      const lines = readFileSync(lp, 'utf8').split('\n').filter(l => l.trim());
      const e2 = JSON.parse(lines[1]);
      assert.ok(e2.sig, 'the second entry is signed');
      e2.data = { v: 999 }; // tampered payload, stale sig
      lines[1] = JSON.stringify(e2);
      writeFileSync(lp, lines.join('\n') + '\n');

      // Lenient mode must STILL reject: a present-but-invalid sig is tampering, not
      // "unsigned history". This is what stops a rewritten signed revocation.
      withKey(KEY, () => {
        const r = verify(dir, { requireSignatures: false });
        assert.equal(r.valid, false);
        assert.equal(r.break.reason, 'signature invalid');
        assert.equal(r.break.seq, 2);
      });
    } finally {
      cleanTmp(dir);
    }
  });
});

// ── T149 / #378: scoped legacy-unsigned-prefix tolerance ─────────────────────
// requireSignatures:false must tolerate ONLY a contiguous legacy prefix (entries
// before the first signed entry in the file), not an unsigned entry anywhere.
// A missing sig after signing was adopted, or ANY invalid sig, must still break
// the chain — otherwise an attacker could regress a signed ledger back to
// "unsigned" by appending plain entries after the fact.

describe('signing: scoped legacy-prefix tolerance (#378)', () => {
  it('unsigned prefix followed by signed entries verifies as valid in lenient mode', () => {
    const dir = makeTmp();
    try {
      withKey(null, () => {
        record({ gate: 'legacy-1', dir });
        record({ gate: 'legacy-2', dir });
      });
      withKey(KEY, () => {
        record({ gate: 'signed-1', dir });
      });
      withKey(KEY, () => {
        const r = verify(dir, { requireSignatures: false });
        assert.equal(r.valid, true);
        assert.equal(r.count, 3);
        // signed:true means "every entry verified cryptographically" — lenient
        // mode does not require that of the legacy prefix, so it must stay false
        // even on an otherwise-clean pass (ticket's explicit signed:true contract).
        assert.equal(r.signed, false);
      });
    } finally {
      cleanTmp(dir);
    }
  });

  it('an unsigned entry AFTER the first signed entry breaks the chain even in lenient mode', () => {
    const dir = makeTmp();
    try {
      withKey(KEY, () => {
        record({ gate: 'signed-1', dir });
      });
      // A later entry recorded with no key — signing was already adopted by this
      // point, so this is a regression, not honest legacy history.
      withKey(null, () => {
        record({ gate: 'plain-after-adoption', dir });
      });
      withKey(KEY, () => {
        const r = verify(dir, { requireSignatures: false });
        assert.equal(r.valid, false);
        assert.equal(r.break.reason, 'unsigned entry');
        assert.equal(r.break.seq, 2);
      });
    } finally {
      cleanTmp(dir);
    }
  });

  it('a legacy-prefix entry with a PRESENT-but-WRONG signature still fails in lenient mode', () => {
    const dir = makeTmp();
    try {
      // e1 sits at the very front of the file (the legacy-prefix position) but
      // carries a sig computed under the WRONG key — forged provenance, not
      // honestly-missing provenance.
      const e1 = buildEntry({
        gate: 'legacy', ticket: undefined, data: undefined, filePaths: [],
        prevRawLine: null, prevSeq: 0, ts: '2024-01-01T00:00:00.000Z', key: 'wrong-key',
      });
      const line1 = JSON.stringify(e1);
      const e2 = buildEntry({
        gate: 'signed', ticket: undefined, data: undefined, filePaths: [],
        prevRawLine: line1, prevSeq: e1.seq, ts: '2024-01-02T00:00:00.000Z', key: KEY,
      });
      const line2 = JSON.stringify(e2);
      const lp = ledgerPath('manifest', dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(lp, line1 + '\n' + line2 + '\n');

      withKey(KEY, () => {
        const r = verify(dir, { requireSignatures: false });
        assert.equal(r.valid, false);
        assert.equal(r.break.reason, 'signature invalid');
        assert.equal(r.break.seq, e1.seq);
      });
    } finally {
      cleanTmp(dir);
    }
  });

  it('strict default (requireSignatures:true) is unchanged: still fails at the first unsigned entry', () => {
    const dir = makeTmp();
    try {
      withKey(null, () => {
        record({ gate: 'legacy-1', dir });
        record({ gate: 'legacy-2', dir });
      });
      withKey(KEY, () => {
        record({ gate: 'signed-1', dir });
      });
      withKey(KEY, () => {
        const r = verify(dir); // no opts → requireSignatures defaults to true
        assert.equal(r.valid, false);
        assert.equal(r.break.reason, 'unsigned entry');
        assert.equal(r.break.seq, 1);
      });
    } finally {
      cleanTmp(dir);
    }
  });
});

describe('signing: no key in env reports signed:false', () => {
  it('hash chain still verifies, but result advertises no provenance', () => {
    const dir = makeTmp();
    try {
      withKey(null, () => {
        record({ gate: 'g1', dir });
        record({ gate: 'g2', dir });
        const r = verify(dir);
        assert.equal(r.valid, true);
        assert.equal(r.signed, false);
        assert.equal(r.count, 2);
      });
    } finally {
      cleanTmp(dir);
    }
  });

  it('signed entries still pass the hash chain when verified without a key', () => {
    const dir = makeTmp();
    try {
      withKey(KEY, () => {
        record({ gate: 'g1', dir });
        record({ gate: 'g2', dir });
      });
      // No key present at verify time: hash chain holds, signed:false.
      withKey(null, () => {
        const r = verify(dir);
        assert.equal(r.valid, true);
        assert.equal(r.signed, false);
      });
    } finally {
      cleanTmp(dir);
    }
  });
});

describe('signing: canonicalEntryBytes is deterministic and excludes sig', () => {
  it('omits sig and fixes key order regardless of input field order', () => {
    const base = {
      seq: 1, gate: 'g', ts: '2024-01-01T00:00:00.000Z',
      ticket: 'T-1', data: { a: 1 }, files: {}, prev: null,
    };
    const withSig = { ...base, sig: 'deadbeef' };
    // Same logical entry, different insertion order + a sig field.
    const reordered = {
      sig: 'deadbeef', prev: null, files: {}, data: { a: 1 },
      ticket: 'T-1', ts: '2024-01-01T00:00:00.000Z', gate: 'g', seq: 1,
    };
    assert.equal(canonicalEntryBytes(base), canonicalEntryBytes(withSig));
    assert.equal(canonicalEntryBytes(base), canonicalEntryBytes(reordered));
    assert.ok(!canonicalEntryBytes(withSig).includes('sig'));
  });

  it('excludes segment too — a signature must survive readManifestForest\'s annotation (T-MANIFEST-FOREST slice 2)', () => {
    // forest.mjs's readManifestForest annotates every entry it returns with
    // `segment` ('root' or a segment filename) — metadata inferred from which
    // file a line was read from, never itself written to disk. Without this
    // exclusion, verifying an entry AS RETURNED BY readManifestForest recomputes
    // different canonical bytes than what was actually signed at write time,
    // and every signature fails — this was caught for real the first time a
    // forest-read entry reached verifyEntrySig (cross-model.mjs).
    const base = {
      seq: 1, gate: 'g', ts: '2024-01-01T00:00:00.000Z',
      ticket: 'T-1', data: { a: 1 }, files: {}, prev: null,
    };
    const annotated = { ...base, segment: 'root' };
    assert.equal(canonicalEntryBytes(base), canonicalEntryBytes(annotated));
    assert.ok(!canonicalEntryBytes(annotated).includes('segment'));

    const signedThenAnnotated = { ...base, sigVersion: 2 };
    signedThenAnnotated.sig = signEntry(KEY, signedThenAnnotated);
    const asReadFromForest = { ...signedThenAnnotated, segment: 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl' };
    assert.equal(verifyEntrySig(KEY, asReadFromForest), true);
  });
});
