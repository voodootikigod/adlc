// gate-manifest tests — node:test, offline, no API keys, temp dirs cleaned up.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { tmp } from '@adlc/core/test-kit';

import { appendManifestEntry as realAppendManifestEntry, record as realRecord, buildEntry, parseData, parseFileList, readLastRawLine } from '../lib/record.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { loadFiltered, renderEntries } from '../lib/show.mjs';
import { buildAttest } from '../lib/attest.mjs';
import { canonicalEntryBytes, KEY_ENV, signEntry, verifyEntrySig } from '../lib/sign.mjs';
import { repairChain as realRepairChain } from '../lib/repair.mjs';
import { specApprovalIntegrityErrors, validateSpecApprovalRecord } from '../index.mjs';
import { editDistance, nearMissIds, validateRecordTicket } from '../lib/ticket-check.mjs';
import { specApprovalIntegrityErrors as runnerSpecApprovalIntegrityErrors, validateSpecApprovalRecord as runnerValidateSpecApprovalRecord } from '../../runner/lib/assertions.mjs';
import { sha256, ledgerPath } from '../../core/index.mjs';

// ── key env helper ─────────────────────────────────────────────────────────────
// Tests mutate process.env[ADLC_MANIFEST_KEY] (read by record/verify via
// sign.getKey). withKey sets it for the duration of fn and always restores,
// so signing tests stay isolated from one another and from the no-key tests.

// The libraries no longer read the environment (spec Layer 2, P1): `key` is an
// explicit required parameter. withKey keeps its shape — every existing test still
// says `withKey('k', () => ...)` — but now scopes the CURRENT TEST KEY that the
// wrappers below thread explicitly into each call. It ALSO still sets process.env
// to the same value: proving the env is inert is the point — if any library
// consulted it, the explicit-param tests and the env would agree by construction,
// and the dedicated key-contract tests (which set env to a DIFFERENT sentinel)
// would catch the fallback.
let currentTestKey = null;
function withKey(key, fn) {
  const prev = process.env[KEY_ENV];
  const prevCurrent = currentTestKey;
  currentTestKey = key;
  if (key === null) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = key;
  try {
    return fn();
  } finally {
    currentTestKey = prevCurrent;
    if (prev === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prev;
  }
}

// Explicit-key wrappers: every call in this file goes through the new required-key
// contract, with the key scoped by withKey (null outside any withKey).
const appendManifestEntry = (payload, dir, opts = {}) =>
  realAppendManifestEntry(payload, dir, { key: currentTestKey, ...opts });
const record = (opts) => realRecord({ key: currentTestKey, ...opts });
const verify = (dir, opts = {}) => realVerify(dir, { key: currentTestKey, ...opts });
const repairChain = (opts = {}) => realRepairChain({ key: currentTestKey, ...opts });

// ── helpers ──────────────────────────────────────────────────────────────────

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
  it('returns null for non-existent file', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    assert.equal(readLastRawLine(join(dir, 'missing.jsonl')), null);
  });

  it('returns null for empty file', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    const p = join(dir, 'empty.jsonl');
    writeFileSync(p, '');
    assert.equal(readLastRawLine(p), null);
  });

  it('returns last non-empty line', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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

  it('hashes real files', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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

  it('single record produces valid chain', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    record({ gate: 'build', dir });
    const r = verify(dir);
    assert.equal(r.valid, true);
    assert.equal(r.count, 1);
  });

  it('three records produce valid chain with monotonic seq', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    const e1 = record({ gate: 'plan', dir });
    const e2 = record({ gate: 'build', dir });
    const e3 = record({ gate: 'test', dir });
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.equal(e3.seq, 3);
    const r = verify(dir);
    assert.equal(r.valid, true);
    assert.equal(r.count, 3);
  });

  it('chains top-level runner evidence after a gate record', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('refuses a payload that supplies any reserved chain field', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    for (const field of ['seq', 'prev', 'sig', 'sigVersion', 'segment', 'anchor', 'branch']) {
      assert.throws(
        () => appendManifestEntry({ type: 'p5-complete', [field]: 'x' }, dir),
        new RegExp(field),
        `payload supplying "${field}" must be refused`,
      );
    }
  });

  it('signs every field of generalized evidence so last-entry tampering fails', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('rejects appending to a legacy unchained tail', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    writeFileSync(ledgerPath('manifest', dir), '{"type":"legacy"}\n');
    assert.throws(
      () => appendManifestEntry({ type: 'p5-complete' }, dir),
      /manifest chain is invalid/
    );
  });

  // #378: appendManifestEntry's pre-append check is scoped the same way verify()
  // is — a signed entry followed by a later unsigned one (e.g. a prior append ran
  // without ADLC_MANIFEST_KEY after signing was already adopted) must refuse
  // further appends, not silently continue degrading provenance.
  it('rejects appending onto a chain where a signed entry is followed by an unsigned one', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('empty ledger is valid', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    const r = verify(dir);
    assert.equal(r.valid, true);
    assert.equal(r.message, 'empty manifest');
  });

  it('record with ticket and data is stored and retrievable', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    record({ gate: 'spec', ticket: 'T-1', rawData: '{"model":"haiku"}', dir });
    const { entries } = loadFiltered({ ticket: 'T-1', dir });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].ticket, 'T-1');
    assert.deepEqual(entries[0].data, { model: 'haiku' });
  });
});

describe('repairChain', () => {
  it('plans without writing, then preserves a backup and rechains mixed evidence', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('re-signs every repaired entry when a manifest key is configured', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('rejects --attest-unsigned when no signing key is configured', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('CLI: a p6-accept record prints the ticket-completion reminder to stderr, a plain gate does not (T74)', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    const bin = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;
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
  });

  // #378: proves --allow-legacy-unsigned is actually wired through parseArgs into
  // verify()'s requireSignatures option via the REAL binary (not just the library
  // function in isolation) — a reverted/typoed/negation-flipped flag would fail here.
  it('CLI: --allow-legacy-unsigned tolerates a legacy-unsigned-prefix manifest; omitting it still fails strict', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    const bin = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;
    const env = { ...process.env, [KEY_ENV]: 'test-key' };
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
  });

  it('requires and audits explicit unsigned attestation through the CLI', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    const bin = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;
    const env = { ...process.env, [KEY_ENV]: 'test-key' };
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
  });

  it('refuses to rewrite signed history under the wrong key', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    withKey('original-key', () => record({ gate: 'rails-bypass', dir }));
    appendFileSync(ledgerPath('manifest', dir), '{"type":"p5-complete"}\n');
    withKey('wrong-key', () => {
      assert.throws(
        () => repairChain({ dir, reason: 'recorder interoperability defect', write: true }),
        /does not match ADLC_MANIFEST_KEY/,
      );
    });
  });
});

// ── tamper detection ──────────────────────────────────────────────────────────

describe('tamper detection', () => {
  // These assert hash-chain behavior specifically; pin to no-key mode so the
  // break reason/seq is the prev-hash mismatch regardless of the runner's env
  // (with a key set, a stale signature would trip first).
  it('tampered middle line → verify exit-2 path with correct seq', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('tampered first entry prev field → verify detects it', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('rejects a first entry without a positive sequence number', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    writeFileSync(ledgerPath('manifest', dir), '{"gate":"forged","prev":null}\n');
    const result = verify(dir);
    assert.equal(result.valid, false);
    assert.equal(result.break.reason, 'invalid seq');
  });

  it('rejects a first entry whose sequence number is not 1 (AC1)', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    writeFileSync(ledgerPath('manifest', dir), '{"seq":2,"gate":"forged","prev":null}\n');
    const result = verify(dir);
    assert.equal(result.valid, false);
    assert.equal(result.break.reason, 'first entry seq must be 1');
    assert.equal(result.break.seq, 2);
    assert.equal(result.count, 0);
  });

  it('rejects non-contiguous sequence numbers with a gap (AC2)', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    const line1 = '{"seq":1,"gate":"plan","prev":null}';
    const line2 = `{"seq":3,"gate":"build","prev":"${sha256(line1)}"}`;
    writeFileSync(ledgerPath('manifest', dir), `${line1}\n${line2}\n`);
    const result = verify(dir);
    assert.equal(result.valid, false);
    assert.equal(result.break.reason, 'seq not contiguous');
    assert.equal(result.break.seq, 3);
    assert.equal(result.count, 1);
  });

  it('rejects non-contiguous sequence numbers with duplicate seq (AC2)', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    const line1 = '{"seq":1,"gate":"plan","prev":null}';
    const line2 = `{"seq":1,"gate":"build","prev":"${sha256(line1)}"}`;
    writeFileSync(ledgerPath('manifest', dir), `${line1}\n${line2}\n`);
    const result = verify(dir);
    assert.equal(result.valid, false);
    assert.equal(result.break.reason, 'seq not contiguous');
    assert.equal(result.break.seq, 1);
    assert.equal(result.count, 1);
  });

  it('rejects non-contiguous sequence numbers with decreasing seq (AC2)', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    const line1 = '{"seq":1,"gate":"plan","prev":null}';
    const line2 = `{"seq":2,"gate":"build","prev":"${sha256(line1)}"}`;
    const line3 = `{"seq":1,"gate":"test","prev":"${sha256(line2)}"}`;
    writeFileSync(ledgerPath('manifest', dir), `${line1}\n${line2}\n${line3}\n`);
    const result = verify(dir);
    assert.equal(result.valid, false);
    assert.equal(result.break.reason, 'seq not contiguous');
    assert.equal(result.break.seq, 1);
    assert.equal(result.count, 2);
  });

  it('rejects a JSON value that is not an entry object', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    writeFileSync(ledgerPath('manifest', dir), 'null\n');
    const result = verify(dir);
    assert.equal(result.valid, false);
    assert.equal(result.break.reason, 'entry must be an object');
  });
});

// ── show filtering ────────────────────────────────────────────────────────────

describe('show filtering', () => {
  function setupShow(t) {
    const dir = tmp(t, 'gate-manifest-test-');
    record({ gate: 'spec', ticket: 'T-1', dir });
    record({ gate: 'build', ticket: 'T-2', dir });
    record({ gate: 'test', ticket: 'T-1', dir });
    return dir;
  }

  it('no filter returns all entries', (t) => {
    const dir = setupShow(t);
    const { entries } = loadFiltered({ dir });
    assert.equal(entries.length, 3);
  });

  it('ticket filter returns only matching entries', (t) => {
    const dir = setupShow(t);
    const { entries } = loadFiltered({ ticket: 'T-1', dir });
    assert.equal(entries.length, 2);
    assert.ok(entries.every(e => e.ticket === 'T-1'));
  });

  it('non-existent ticket returns empty', (t) => {
    const dir = setupShow(t);
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

  it('renders seq/gate/ts for each entry', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    record({ gate: 'my-gate', ticket: 'T-1', dir });
    const { entries } = loadFiltered({ dir });
    const lines = renderEntries(entries);
    const joined = lines.join('\n');
    assert.ok(joined.includes('gate=my-gate'));
    assert.ok(joined.includes('ticket: T-1'));
  });
});

// ── attest rendering ──────────────────────────────────────────────────────────

describe('attest', () => {
  function setupAttest(t) {
    const dir = tmp(t, 'gate-manifest-test-');
    record({ gate: 'spec',  ticket: 'T-5', dir });
    record({ gate: 'build', ticket: 'T-5', rawData: '{"model":"haiku"}', dir });
    return dir;
  }

  it('produces markdown heading with ticket', (t) => {
    const dir = setupAttest(t);
    const md = buildAttest({ ticket: 'T-5', dir });
    assert.ok(md.includes('## Gate evidence for T-5'));
  });

  it('includes gate names in the table', (t) => {
    const dir = setupAttest(t);
    const md = buildAttest({ ticket: 'T-5', dir });
    assert.ok(md.includes('spec'));
    assert.ok(md.includes('build'));
  });

  it('includes chain status', (t) => {
    const dir = setupAttest(t);
    const md = buildAttest({ ticket: 'T-5', dir });
    assert.ok(md.includes('Chain status:'));
    assert.ok(md.includes('valid'));
  });

  it('marks chain as BROKEN when tampered', (t) => {
    const badDir = tmp(t, 'gate-manifest-test-');
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
  });

  it('attest without ticket shows all entries', (t) => {
    const dir = setupAttest(t);
    const md = buildAttest({ dir });
    assert.ok(md.includes('## Gate evidence'));
    // Should show both entries (T-5 spec and T-5 build)
    assert.ok(md.includes('spec'));
    assert.ok(md.includes('build'));
  });
});

// ── --files hashing ───────────────────────────────────────────────────────────

describe('--files hashing', () => {
  it('hashes listed files and includes them in entry', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    const fileA = join(dir, 'fileA.txt');
    const fileB = join(dir, 'fileB.txt');
    writeFileSync(fileA, 'content of A');
    writeFileSync(fileB, 'content of B');
    const ledgerDir = tmp(t, 'gate-manifest-test-');
    const e = record({ gate: 'hash-test', rawFiles: `${fileA},${fileB}`, dir: ledgerDir });
    assert.ok(e.files[fileA]);
    assert.ok(e.files[fileB]);
    assert.equal(e.files[fileA], sha256('content of A'));
    assert.equal(e.files[fileB], sha256('content of B'));
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
  it('each record increments seq by 1', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(record({ gate: `gate-${i}`, dir }));
    }
    for (let i = 0; i < 5; i++) {
      assert.equal(entries[i].seq, i + 1);
    }
  });
});

// ── HMAC signing (keyed provenance) ───────────────────────────────────────────
// The hash chain alone is keyless: a writer can recompute every `prev` and
// forge a clean chain. These tests assert that with ADLC_MANIFEST_KEY set,
// only entries signed under the secret key verify — defeating that forgery.

const KEY = 'test-secret-key-do-not-ship';

describe('signing: signed record round-trip', () => {
  it('two signed records verify as valid AND signed', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });
});

describe('signing: forge-from-scratch attack is caught', () => {
  it('a hand-built chain with correct prev hashes but no key fails verify with key', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });
});

describe('signing: tamper after signing is caught', () => {
  it('editing a signed entry\'s data without re-signing → signature invalid', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('requireSignatures:false tolerates an UNSIGNED entry but still rejects a TAMPERED signature (#354 F1)', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });
});

// ── T149 / #378: scoped legacy-unsigned-prefix tolerance ─────────────────────
// requireSignatures:false must tolerate ONLY a contiguous legacy prefix (entries
// before the first signed entry in the file), not an unsigned entry anywhere.
// A missing sig after signing was adopted, or ANY invalid sig, must still break
// the chain — otherwise an attacker could regress a signed ledger back to
// "unsigned" by appending plain entries after the fact.

describe('signing: scoped legacy-prefix tolerance (#378)', () => {
  it('unsigned prefix followed by signed entries verifies as valid in lenient mode', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('an unsigned entry AFTER the first signed entry breaks the chain even in lenient mode', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('a legacy-prefix entry with a PRESENT-but-WRONG signature still fails in lenient mode', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });

  it('strict default (requireSignatures:true) is unchanged: still fails at the first unsigned entry', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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
  });
});

describe('signing: no key in env reports signed:false', () => {
  it('hash chain still verifies, but result advertises no provenance', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
    withKey(null, () => {
      record({ gate: 'g1', dir });
      record({ gate: 'g2', dir });
      const r = verify(dir);
      assert.equal(r.valid, true);
      assert.equal(r.signed, false);
      assert.equal(r.count, 2);
    });
  });

  it('signed entries still pass the hash chain when verified without a key', (t) => {
    const dir = tmp(t, 'gate-manifest-test-');
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


// ── spec-approval pre-record validation (#1181) ──────────────────────────────

describe('spec-approval validation (#1181)', () => {
  function makeSpec(dir, name = 'spec.md', content = '# Spec\n## Acceptance Criteria\n- ok: `true`\n') {
    const specPath = join(dir, name);
    writeFileSync(specPath, content);
    const hash = sha256(readFileSync(specPath));
    return { specPath, hash };
  }

  function validData(hash, overrides = {}) {
    return {
      verdict: 'approved',
      approver: 'alice',
      spec_hash: hash,
      rounds: 1,
      questions: 1,
      sources: ['premortem'],
      unresolved: 0,
      approved_assumptions: [],
      ...overrides,
    };
  }

  function slEntry(ticket, specPath, hash, verified = true) {
    return {
      gate: 'spec-lint',
      ticket,
      data: verified === null ? {} : { verified },
      files: specPath ? { [specPath]: hash } : {},
    };
  }

  function pmEntry(ticket, specPath, hash) {
    return {
      gate: 'premortem',
      ticket,
      data: { verdict: 'ok' },
      files: specPath ? { [specPath]: hash } : {},
    };
  }

  function approvalEntry(ticket, specPath, hash, overrides = {}) {
    return {
      gate: 'spec-approval',
      ticket,
      data: validData(hash, overrides),
      files: specPath ? { [specPath]: hash } : {},
    };
  }

  it('returns [] when no spec-approval entry matches and evaluates only the latest matching entry', (t) => {
    const dir = tmp(t, 'gate-manifest-spec-');
    const { specPath, hash } = makeSpec(dir);
    assert.deepEqual(specApprovalIntegrityErrors([], 'T1', dir), []);
    assert.deepEqual(specApprovalIntegrityErrors([slEntry('T1', specPath, hash)], 'T1', dir), []);
    assert.deepEqual(specApprovalIntegrityErrors([approvalEntry('T2', specPath, hash, { verdict: 'rejected' })], 'T1', dir), []);

    // Earlier rejected approval followed by valid latest approval → passes
    const entriesPass = [
      slEntry('T1', specPath, hash),
      pmEntry('T1', specPath, hash),
      approvalEntry('T1', specPath, hash, { verdict: 'rejected' }),
      approvalEntry('T1', specPath, hash),
    ];
    assert.deepEqual(specApprovalIntegrityErrors(entriesPass, 'T1', dir), []);

    // Earlier valid approval followed by rejected latest approval → fails
    const entriesFail = [
      slEntry('T1', specPath, hash),
      pmEntry('T1', specPath, hash),
      approvalEntry('T1', specPath, hash),
      { type: 'spec-approval', ticket: 'T1', data: validData(hash, { verdict: 'rejected' }), files: { [specPath]: hash } },
    ];
    const errs = specApprovalIntegrityErrors(entriesFail, 'T1', dir);
    assert.ok(errs.some((e) => e.includes('Gate 1')));
  });

  it('validates unscoped entries when ticket is undefined and uses default cwd', (t) => {
    const dir = tmp(t, 'gate-manifest-spec-');
    const { specPath, hash } = makeSpec(dir);
    const entries = [
      { type: 'spec-lint', data: { verified: true }, files: { [specPath]: hash } },
      { type: 'premortem', data: { verdict: 'ok' }, files: { [specPath]: hash } },
      { type: 'spec-approval', data: validData(hash, { approved_assumptions: undefined }), files: { [specPath]: hash } },
    ];
    assert.deepEqual(specApprovalIntegrityErrors(entries), []);
  });

  it('rejects missing, null, primitive, or array data payload', () => {
    for (const bad of [undefined, null, 'str', 123, []]) {
      const errs = specApprovalIntegrityErrors([{ gate: 'spec-approval', ticket: 'T1', data: bad }], 'T1');
      assert.deepEqual(errs, ['P1 evidence is incomplete: spec-approval missing interrogation payload (data)']);
    }
  });

  it('validates every interrogation field and file/hash/prerequisite invariant', (t) => {
    const dir = tmp(t, 'gate-manifest-spec-');
    const { specPath, hash } = makeSpec(dir);
    const baseEntries = [slEntry('T1', specPath, hash), pmEntry('T1', specPath, hash)];

    // verdict !== 'approved'
    let errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash, { verdict: 'pending' }), files: [specPath], entries: baseEntries, cwd: dir });
    assert.ok(errs.some((e) => e.includes('Gate 1')));

    // approver missing / non-string / whitespace
    for (const approver of [undefined, 42, '', '   ']) {
      errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash, { approver }), files: [specPath], entries: baseEntries, cwd: dir });
      assert.ok(errs.some((e) => e.includes('non-empty approver')));
    }

    // rounds & questions boundaries (0, negative, float, non-number fail; 1 passes)
    for (const bad of [0, -1, 1.5, '1', undefined]) {
      errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash, { rounds: bad }), files: [specPath], entries: baseEntries, cwd: dir });
      assert.ok(errs.some((e) => e.includes('positive integer rounds')));
      errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash, { questions: bad }), files: [specPath], entries: baseEntries, cwd: dir });
      assert.ok(errs.some((e) => e.includes('positive integer questions')));
    }

    // sources missing / non-array / empty
    for (const sources of [undefined, 'premortem', []]) {
      errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash, { sources }), files: [specPath], entries: baseEntries, cwd: dir });
      assert.ok(errs.some((e) => e.includes('at least one interrogation source')));
    }
    // sources with non-string or blank element
    for (const sources of [[''], ['  '], ['premortem', 123]]) {
      errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash, { sources }), files: [specPath], entries: baseEntries, cwd: dir });
      assert.ok(errs.some((e) => e.includes('non-empty strings')));
    }
    // 1-char source string is valid
    errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash, { sources: ['x'] }), files: specPath, entries: baseEntries, cwd: dir });
    assert.deepEqual(errs, []);

    // unresolved !== 0
    for (const unresolved of [1, -1, undefined, '0']) {
      errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash, { unresolved }), files: [specPath], entries: baseEntries, cwd: dir });
      assert.ok(errs.some((e) => e.includes('unresolved === 0')));
    }

    // approved_assumptions optional array
    errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash, { approved_assumptions: 'not-array' }), files: [specPath], entries: baseEntries, cwd: dir });
    assert.ok(errs.some((e) => e.includes('approved_assumptions must be an array')));

    // files count !== 1 (0 files or 2 files) -> only reports the single file binding error, not audit mismatch
    errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash), files: [], entries: baseEntries, cwd: dir });
    assert.deepEqual(errs, ['P1 evidence is incomplete: spec-approval must bind exactly one spec file via --files']);
    const otherSpec = makeSpec(dir, 'other.md');
    errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash), files: [specPath, otherSpec.specPath], entries: baseEntries, cwd: dir });
    assert.deepEqual(errs, ['P1 evidence is incomplete: spec-approval must bind exactly one spec file via --files']);
    errs = specApprovalIntegrityErrors([...baseEntries, { gate: 'spec-approval', ticket: 'T1', data: validData(hash) }], 'T1', dir);
    assert.deepEqual(errs, ['P1 evidence is incomplete: spec-approval must bind exactly one spec file via --files']);

    // spec_hash missing / non-string / empty / mismatched
    for (const spec_hash of [undefined, 123, '']) {
      errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash, { spec_hash }), files: [specPath], entries: baseEntries, cwd: dir });
      assert.ok(errs.some((e) => e.includes('missing spec_hash')));
    }
    errs = validateSpecApprovalRecord({ ticket: 'T1', data: validData(hash, { spec_hash: 'wrong-hash' }), files: [specPath], entries: baseEntries, cwd: dir });
    assert.ok(errs.some((e) => e.includes('spec_hash does not match')));

    // stale or unreadable spec file on disk
    const staleEntries = [...baseEntries, approvalEntry('T1', specPath, hash)];
    writeFileSync(specPath, '# Spec modified after approval\n');
    errs = specApprovalIntegrityErrors(staleEntries, 'T1', dir);
    assert.ok(errs.some((e) => e.includes('spec file changed after approval was recorded')));

    const missingPath = join(dir, 'nonexistent.md');
    errs = specApprovalIntegrityErrors(
      [slEntry('T1', missingPath, hash), pmEntry('T1', missingPath, hash), approvalEntry('T1', missingPath, hash)],
      'T1',
      dir,
    );
    assert.ok(errs.some((e) => e.includes('spec file cannot be read')));

    // restore spec file for audit prerequisite checks
    writeFileSync(specPath, '# Spec\n## Acceptance Criteria\n- ok: `true`\n');

    // spec-lint ordering, ticket scoping, file binding, hash match, and verified:true
    errs = specApprovalIntegrityErrors([pmEntry('T1', specPath, hash), approvalEntry('T1', specPath, hash), slEntry('T1', specPath, hash)], 'T1', dir);
    assert.ok(errs.some((e) => e.includes('before the latest spec-lint')));

    errs = specApprovalIntegrityErrors([slEntry('T2', specPath, hash), pmEntry('T1', specPath, hash), approvalEntry('T1', specPath, hash)], 'T1', dir);
    assert.ok(errs.some((e) => e.includes('before the latest spec-lint')));

    errs = specApprovalIntegrityErrors([{ gate: 'spec-lint', ticket: 'T1', data: { verified: true } }, pmEntry('T1', specPath, hash), approvalEntry('T1', specPath, hash)], 'T1', dir);
    assert.ok(errs.some((e) => e.includes('spec-lint evidence for this ticket does not audit')));

    errs = specApprovalIntegrityErrors([
      { gate: 'spec-lint', ticket: 'T1', data: { verified: true }, files: { [specPath]: hash, [otherSpec.specPath]: otherSpec.hash } },
      pmEntry('T1', specPath, hash),
      approvalEntry('T1', specPath, hash),
    ], 'T1', dir);
    assert.ok(errs.some((e) => e.includes('spec-lint evidence for this ticket does not audit')));

    errs = specApprovalIntegrityErrors([slEntry('T1', otherSpec.specPath, otherSpec.hash), pmEntry('T1', specPath, hash), approvalEntry('T1', specPath, hash)], 'T1', dir);
    assert.ok(errs.some((e) => e.includes('spec-lint evidence for this ticket does not audit')));

    errs = specApprovalIntegrityErrors([slEntry('T1', specPath, 'stale-hash'), pmEntry('T1', specPath, hash), approvalEntry('T1', specPath, hash)], 'T1', dir);
    assert.ok(errs.some((e) => e.includes('spec-lint evidence for this ticket does not audit')));

    for (const verified of [false, null]) {
      errs = specApprovalIntegrityErrors([slEntry('T1', specPath, hash, verified), pmEntry('T1', specPath, hash), approvalEntry('T1', specPath, hash)], 'T1', dir);
      assert.ok(errs.some((e) => e.includes('not a verified (passing) result')));
    }

    // premortem ordering, ticket scoping, file binding, and hash match
    errs = specApprovalIntegrityErrors([slEntry('T1', specPath, hash), approvalEntry('T1', specPath, hash), pmEntry('T1', specPath, hash)], 'T1', dir);
    assert.ok(errs.some((e) => e.includes('before the latest premortem')));

    errs = specApprovalIntegrityErrors([slEntry('T1', specPath, hash), pmEntry('T2', specPath, hash), approvalEntry('T1', specPath, hash)], 'T1', dir);
    assert.ok(errs.some((e) => e.includes('before the latest premortem')));

    errs = specApprovalIntegrityErrors([slEntry('T1', specPath, hash), pmEntry('T1', otherSpec.specPath, otherSpec.hash), approvalEntry('T1', specPath, hash)], 'T1', dir);
    assert.ok(errs.some((e) => e.includes('premortem evidence for this ticket does not analyze')));

    errs = specApprovalIntegrityErrors([slEntry('T1', specPath, hash), pmEntry('T1', specPath, 'stale-hash'), approvalEntry('T1', specPath, hash)], 'T1', dir);
    assert.ok(errs.some((e) => e.includes('premortem evidence for this ticket does not analyze')));

    // relative vs absolute path resolution
    errs = specApprovalIntegrityErrors([slEntry('T1', 'spec.md', hash), pmEntry('T1', 'spec.md', hash), approvalEntry('T1', specPath, hash)], 'T1', dir);
    assert.deepEqual(errs, []);

    // validateSpecApprovalRecord default args and shared identity with @adlc/runner
    assert.ok(validateSpecApprovalRecord().length > 0);
    assert.equal(specApprovalIntegrityErrors, runnerSpecApprovalIntegrityErrors);
    assert.equal(validateSpecApprovalRecord, runnerValidateSpecApprovalRecord);
  });

  it('CLI: rejects invalid spec-approval without modifying the manifest, allows --force, and records valid approval (#1181)', (t) => {
    const dir = tmp(t, 'gate-manifest-cli-spec-');
    const bin = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;
    const { specPath, hash } = makeSpec(dir);

    // Usage string includes --force
    const noVerb = spawnSync(process.execPath, [bin], { encoding: 'utf8' });
    assert.equal(noVerb.status, 1);
    assert.ok(noVerb.stderr.includes("verbs: record <gate-name> [--ticket id] [--data '{json}'] [--files a,b,c] [--force]"));

    // Seed prerequisite spec-lint and premortem for T1 (and unrelated T2)
    withKey(null, () => {
      appendManifestEntry(slEntry('T1', specPath, hash), dir);
      appendManifestEntry(pmEntry('T1', specPath, hash), dir);
    });
    const manifestPath = ledgerPath('manifest', dir);
    const bytesBefore = readFileSync(manifestPath, 'utf8');

    // 1. Empty sources -> exit 1, manifest bytes unchanged
    const emptySources = spawnSync(
      process.execPath,
      [bin, 'record', 'spec-approval', '--ticket', 'T1', '--dir', dir, '--files', specPath, '--data', JSON.stringify(validData(hash, { sources: [] }))],
      { encoding: 'utf8' },
    );
    assert.equal(emptySources.status, 1);
    assert.match(emptySources.stderr, /at least one interrogation source/);
    assert.equal(readFileSync(manifestPath, 'utf8'), bytesBefore, 'manifest bytes must remain unchanged after rejected spec-approval');

    // 2. Wrong spec_hash -> exit 1, manifest bytes unchanged
    const badHash = spawnSync(
      process.execPath,
      [bin, 'record', 'spec-approval', '--ticket', 'T1', '--dir', dir, '--files', specPath, '--data', JSON.stringify(validData(hash, { spec_hash: 'wrong-hash' }))],
      { encoding: 'utf8' },
    );
    assert.equal(badHash.status, 1);
    assert.match(badHash.stderr, /spec_hash does not match/);
    assert.equal(readFileSync(manifestPath, 'utf8'), bytesBefore, 'manifest bytes must remain unchanged after wrong spec_hash');

    // 3. Cross-ticket prerequisite mismatch (T2 has no spec-lint/premortem) -> exit 1, manifest bytes unchanged
    const wrongTicket = spawnSync(
      process.execPath,
      [bin, 'record', 'spec-approval', '--ticket', 'T2', '--dir', dir, '--files', specPath, '--data', JSON.stringify(validData(hash))],
      { encoding: 'utf8' },
    );
    assert.equal(wrongTicket.status, 1);
    assert.match(wrongTicket.stderr, /before the latest spec-lint/);
    assert.equal(readFileSync(manifestPath, 'utf8'), bytesBefore, 'manifest bytes must remain unchanged after cross-ticket rejection');

    // 4. Valid spec-approval for T1 -> exit 0, appends entry
    const validRes = spawnSync(
      process.execPath,
      [bin, 'record', 'spec-approval', '--ticket', 'T1', '--dir', dir, '--files', specPath, '--data', JSON.stringify(validData(hash))],
      { encoding: 'utf8' },
    );
    assert.equal(validRes.status, 0, validRes.stderr);
    const afterValid = readFileSync(manifestPath, 'utf8');
    assert.notEqual(afterValid, bytesBefore);
    assert.equal(afterValid.trim().split('\n').length, 3);

    // 5. --force bypasses validation even with invalid payload -> exit 0, appends entry
    const forced = spawnSync(
      process.execPath,
      [bin, 'record', 'spec-approval', '--ticket', 'T1', '--dir', dir, '--force', '--data', JSON.stringify({ verdict: 'rejected' })],
      { encoding: 'utf8' },
    );
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(readFileSync(manifestPath, 'utf8').trim().split('\n').length, 4);
  });
});


// ── ticket validation on record (#893) ───────────────────────────────────────

describe('ticket-check (#893)', () => {
  it('editDistance computes bounded Levenshtein distance and respects cap', () => {
    assert.equal(editDistance('', '', 2), 0);
    assert.equal(editDistance('', 'AB', 2), 2);
    assert.equal(editDistance('AB', '', 2), 2);
    assert.equal(editDistance('T1', 'T1', 2), 0);
    assert.equal(editDistance('T1', 'T2', 2), 1);
    assert.equal(editDistance('ABC', 'AC', 2), 1);
    assert.equal(editDistance('AC', 'ABC', 2), 1);
    assert.equal(editDistance('T1', 'T123', 2), 2);
    assert.equal(editDistance('T1', 'T12345', 2), 3);
    assert.equal(editDistance('AAAA', 'BBBB', 2), 3);
    assert.equal(editDistance('T1000', 'T9999'), 3);
  });

  it('nearMissIds matches case-insensitively within cap, sorts by distance, and slices to limit', () => {
    assert.deepEqual(nearMissIds('T-000', ['T-001', 'T-999']), ['T-001']);
    assert.deepEqual(nearMissIds('t-1a', ['T-1B', 'OTHER-ID']), ['T-1B']);
    assert.deepEqual(nearMissIds('T10', ['T99', 'T11']), ['T11', 'T99']);
    assert.deepEqual(nearMissIds('T1', ['T2', 'T3', 'T4'], { limit: 2 }), ['T2', 'T3']);
  });

  it('validateRecordTicket handles missing ticket, absent store, legacy store, sharded store, near misses, and malformed store', (t) => {
    assert.deepEqual(validateRecordTicket(), { ok: true, status: 0, message: null });
    const emptyDir = tmp(t, 'gm-ticket-empty-');
    assert.deepEqual(validateRecordTicket({ ticket: undefined, dir: emptyDir }), { ok: true, status: 0, message: null });
    assert.deepEqual(validateRecordTicket({ ticket: '', dir: emptyDir }), { ok: true, status: 0, message: null });
    assert.deepEqual(validateRecordTicket({ ticket: 'T1', dir: emptyDir }), { ok: true, status: 0, message: null });

    // Legacy tickets.json store with T1
    const legacyDir = tmp(t, 'gm-ticket-legacy-');
    const validTicket = { id: 'T1', title: 'Valid ticket', body: 'Body', scope: ['src/**'], rails: [] };
    writeFileSync(join(legacyDir, 'tickets.json'), JSON.stringify({ tickets: [validTicket] }));
    assert.deepEqual(validateRecordTicket({ ticket: 'T1', dir: legacyDir }), { ok: true, status: 0, message: null });

    // Unknown ticket with 1 near miss -> status 2
    const missNear = validateRecordTicket({ ticket: 'T2', dir: legacyDir });
    assert.equal(missNear.ok, false);
    assert.equal(missNear.status, 2);
    assert.match(missNear.message, /ticket "T2" not found/);
    assert.match(missNear.message, /\(near-miss id\(s\): T1\)/);
    assert.match(missNear.message, /--allow-unknown-ticket/);

    // Unknown ticket with 0 near misses -> status 2 without near-miss suffix
    const missFar = validateRecordTicket({ ticket: ' COMPLETELY-DIFFERENT-ID ', dir: legacyDir });
    assert.equal(missFar.ok, false);
    assert.equal(missFar.status, 2);
    assert.doesNotMatch(missFar.message, /near-miss/);

    // allowUnknownTicket: true bypasses unknown-id failure
    assert.deepEqual(
      validateRecordTicket({ ticket: 'T2', dir: legacyDir, allowUnknownTicket: true }),
      { ok: true, status: 0, message: null },
    );

    // Sharded tickets/ directory (no tickets.json file)
    const shardedDir = tmp(t, 'gm-ticket-sharded-');
    const shardsPath = join(shardedDir, 'tickets');
    mkdirSync(shardsPath, { recursive: true });
    writeFileSync(join(shardsPath, '.store.json'), JSON.stringify({"format":"adlc-ticket-directory","version":1}));
    const shardBody = JSON.stringify({
      body: 'Body',
      id: 'T1',
      rails: [],
      scope: ['src/**'],
      title: 'Sharded',
    }, null, 2) + '\n';
    writeFileSync(join(shardsPath, "t1--1f93603db53bfad5c92390f735d0cbb8617b4ab8214ae91c5664a3d1e9b009c8.json"), shardBody);
    assert.deepEqual(validateRecordTicket({ ticket: 'T1', dir: shardedDir }), { ok: true, status: 0, message: null });
    assert.equal(validateRecordTicket({ ticket: 'T9', dir: shardedDir }).status, 2);

    // Malformed store (duration: 'M') -> status 1 even when allowUnknownTicket: true
    const badDir = tmp(t, 'gm-ticket-bad-');
    writeFileSync(
      join(badDir, 'tickets.json'),
      JSON.stringify({ tickets: [{ ...validTicket, duration: 'M' }] }),
    );
    const badRes = validateRecordTicket({ ticket: 'T1', dir: badDir, allowUnknownTicket: true });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.status, 1);
    assert.match(badRes.message, /could not load tickets/);
    assert.match(badRes.message, /duration/);
  });

  it('CLI: enforces ticket store validation on record (#893)', (t) => {
    const bin = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;

    // 1. Store with T1 only; record --ticket T2 -> exit 2, stderr lists T1 as near miss, manifest unchanged
    const dir1 = tmp(t, 'gm-cli-ticket-1-');
    const validTicket = { id: 'T1', title: 'Valid ticket', body: 'Body', scope: ['src/**'], rails: [] };
    writeFileSync(join(dir1, 'tickets.json'), JSON.stringify({ tickets: [validTicket] }));
    const manifest1 = ledgerPath('manifest', dir1);
    const r1 = spawnSync(process.execPath, [bin, 'record', 'rails-guard', '--ticket', 'T2', '--dir', dir1], { encoding: 'utf8' });
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /ticket "T2" not found/);
    assert.match(r1.stderr, /T1/);
    assert.equal(existsSync(manifest1), false);

    // 2. Same with --allow-unknown-ticket -> exit 0, entry written
    const r2 = spawnSync(
      process.execPath,
      [bin, 'record', 'rails-guard', '--ticket', 'T2', '--allow-unknown-ticket', '--dir', dir1],
      { encoding: 'utf8' },
    );
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(existsSync(manifest1), true);
    assert.equal(JSON.parse(readFileSync(manifest1, 'utf8').trim()).ticket, 'T2');

    // 3. Malformed store (duration: 'M') -> exit 1 quoting loader error, manifest unchanged
    const dir3 = tmp(t, 'gm-cli-ticket-3-');
    writeFileSync(
      join(dir3, 'tickets.json'),
      JSON.stringify({ tickets: [{ ...validTicket, duration: 'M' }] }),
    );
    const manifest3 = ledgerPath('manifest', dir3);
    const r3 = spawnSync(process.execPath, [bin, 'record', 'rails-guard', '--ticket', 'T1', '--dir', dir3], { encoding: 'utf8' });
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /could not load tickets/);
    assert.match(r3.stderr, /duration/);
    assert.equal(existsSync(manifest3), false);

    // 4. No ticket store in dir -> record --ticket X -> exit 0, entry written
    const dir4 = tmp(t, 'gm-cli-ticket-4-');
    const manifest4 = ledgerPath('manifest', dir4);
    const r4 = spawnSync(process.execPath, [bin, 'record', 'rails-guard', '--ticket', 'X', '--dir', dir4], { encoding: 'utf8' });
    assert.equal(r4.status, 0, r4.stderr);
    assert.equal(existsSync(manifest4), true);
    assert.equal(JSON.parse(readFileSync(manifest4, 'utf8').trim()).ticket, 'X');
  });
});
