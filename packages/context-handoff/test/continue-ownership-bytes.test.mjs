// continue-ownership-bytes.test.mjs — rollback ownership tokens are carried
// from the write calls themselves, never sampled from disk afterwards. A
// post-write sample can adopt a concurrent replacement as "ours" and let a
// failure-path rollback destroy it; a carried token makes that replacement
// FOREIGN by construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic, writeTextAtomic, writeTextExclusive } from '../lib/atomic-json.mjs';
import { writeCapture } from '../lib/capture.mjs';
import { writeFinal } from '../lib/final.mjs';
import { writeDenyRecord } from '../lib/deny-persist.mjs';
import { writeResumeAuth } from '../lib/resume-auth.mjs';
import { restoreIfOurs } from '../lib/rollback.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'adlc-ownership-'));
const KEY = 'test-manifest-key';

test('every writer returns the exact bytes it put on disk', () => {
  const root = scratch();

  const text = writeTextAtomic(join(root, 'a.txt'), 'alpha\n');
  assert.equal(text.bytes, 'alpha\n');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), text.bytes);

  const excl = writeTextExclusive(join(root, 'b.txt'), 'beta\n');
  assert.equal(excl.bytes, 'beta\n');
  assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), excl.bytes);

  const json = writeJsonAtomic(join(root, 'c.json'), { c: 1 });
  assert.equal(readFileSync(join(root, 'c.json'), 'utf8'), json.bytes);

  const final = writeFinal(root, { sessionId: 'sess-own-1', ticketId: 'T900', contentHash: 'h'.repeat(64) });
  assert.ok(final.ok);
  assert.equal(readFileSync(final.path, 'utf8'), final.bytes);

  const record = writeDenyRecord(root, {
    session_id: 'sess-own-1',
    ticket_id: 'T900',
    content_hash: 'h'.repeat(64),
    status: 'open',
    since: new Date().toISOString(),
    host: 'test',
    schema: 1,
  });
  assert.ok(record.ok);
  assert.equal(readFileSync(record.path, 'utf8'), record.bytes);

  const auth = writeResumeAuth(
    root,
    'sess-own-2',
    { ticketId: 'T900', contentHash: 'h'.repeat(64), denySessionId: 'sess-own-1' },
    { key: KEY, exclusive: true },
  );
  assert.ok(auth.ok);
  assert.equal(readFileSync(auth.path, 'utf8'), auth.bytes);
});

// The deterministic replacement test the sampling window used to make
// impossible: divert the bytes on their way to disk (what a concurrent
// replacement in the old sample window amounts to) and the rollback must treat
// the disk as foreign — conflict reported, replacement preserved, nothing
// restored over it.
test('a write diverted on its way to disk is foreign to the rollback', () => {
  const root = scratch();
  const path = join(root, 'diverted.json');
  const divert = {
    mkdirSync,
    existsSync,
    renameSync,
    unlinkSync,
    writeFileSync: (p, body, opts) => writeFileSync(p, `${body}tampered\n`, opts),
  };

  const wrote = writeTextAtomic(path, 'ours\n', { fs: divert });
  assert.equal(wrote.bytes, 'ours\n', 'the token is the requested write, not the disk outcome');
  assert.equal(readFileSync(path, 'utf8'), 'ours\ntampered\n');

  const undo = restoreIfOurs({ path, wroteBytes: wrote.bytes, priorBytes: null, label: 'diverted' });
  assert.equal(undo.conflict, true, 'foreign bytes must be reported, not deleted');
  assert.equal(undo.restored, false);
  assert.ok(existsSync(path), 'the replacement survives the rollback');
  assert.equal(readFileSync(path, 'utf8'), 'ours\ntampered\n');
});

test('the capture writer carries its own bytes the same way', () => {
  const root = scratch();
  const divert = {
    mkdirSync,
    existsSync,
    renameSync,
    unlinkSync,
    writeFileSync: (p, body, opts) => writeFileSync(p, `${body}foreign\n`, opts),
  };

  const wrote = writeCapture(root, 'sess-own-3', 'handoff body\n', { fs: divert });
  assert.ok(wrote.ok);
  assert.equal(wrote.bytes, 'handoff body\n', 'token is the requested capture, not the disk outcome');

  const undo = restoreIfOurs({ path: wrote.path, wroteBytes: wrote.bytes, priorBytes: null, label: 'capture' });
  assert.equal(undo.conflict, true);
  assert.ok(existsSync(wrote.path), 'the diverging capture is preserved');
});

test('the exclusive create claim carries its own bytes the same way', () => {
  const root = scratch();
  const path = join(root, 'claimed.json');
  const divert = {
    mkdirSync,
    writeFileSync: (p, body, opts) => writeFileSync(p, `${body}intruder\n`, opts),
  };

  const wrote = writeTextExclusive(path, 'claim\n', { fs: divert });
  assert.equal(wrote.bytes, 'claim\n');

  const undo = restoreIfOurs({ path, wroteBytes: wrote.bytes, priorBytes: null, label: 'claim' });
  assert.equal(undo.conflict, true);
  assert.ok(existsSync(path), 'the diverging grant is preserved for the operator');
});
