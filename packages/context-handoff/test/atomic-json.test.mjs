// atomic-json.test.mjs — the write-then-rename primitive under every handoff
// artifact (deny markers, finals, resume-auth, locks, captures).
//
// The serialization format is contract, not incidental: these files are read by
// operators in a terminal and pasted into issues, and `handoff repair` exists
// because someone has to look at one and understand it. Nothing else in the
// suite asserts the bytes — every other test parses the JSON back, which is
// exactly the reading that cannot notice the format changing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJsonFile, readTextFile, writeJsonAtomic, writeTextAtomic } from '../lib/atomic-json.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-atomic-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('JSON artifacts are two-space indented and newline terminated', () => {
  withTempDir((dir) => {
    const path = join(dir, 'nested', 'record.json');
    assert.deepEqual(writeJsonAtomic(path, { session_id: 's', ticket_id: null }), {
      ok: true,
      bytes: '{\n  "session_id": "s",\n  "ticket_id": null\n}\n',
    });
    assert.equal(
      readFileSync(path, 'utf8'),
      '{\n  "session_id": "s",\n  "ticket_id": null\n}\n',
    );
  });
});

test('a written artifact reads back as the value that was written', () => {
  withTempDir((dir) => {
    const path = join(dir, 'record.json');
    const value = { schema: 1, status: 'open', binds: { ticket_id: 'T155' }, list: [1, 2] };
    writeJsonAtomic(path, value);
    const got = readJsonFile(path);
    assert.equal(got.ok, true);
    assert.deepEqual(got.value, value);
  });
});

test('the write leaves no temp sibling behind', () => {
  withTempDir((dir) => {
    writeJsonAtomic(join(dir, 'record.json'), { a: 1 });
    assert.deepEqual(readdirSync(dir), ['record.json'], 'a stray .tmp is a half-written artifact');
  });
});

test('text is written verbatim — no trailing newline is invented', () => {
  withTempDir((dir) => {
    const path = join(dir, 'capture.md');
    assert.deepEqual(writeTextAtomic(path, '## Ticket\n\nbody'), {
      ok: true,
      bytes: '## Ticket\n\nbody',
    });
    // Captures are hashed, so a newline this writer adds would move content_hash
    // away from the body its caller hashed.
    assert.equal(readFileSync(path, 'utf8'), '## Ticket\n\nbody');
    assert.deepEqual(readTextFile(path), { ok: true, text: '## Ticket\n\nbody' });
  });
});

test('reads distinguish absent from unreadable from malformed', () => {
  withTempDir((dir) => {
    assert.deepEqual(readJsonFile(join(dir, 'nope.json')), { ok: false, error: 'missing' });
    assert.deepEqual(readTextFile(join(dir, 'nope.json')), { ok: false, error: 'missing' });

    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json', 'utf8');
    assert.deepEqual(readJsonFile(corrupt), { ok: false, error: 'corrupt_json' });

    const array = join(dir, 'array.json');
    writeFileSync(array, '[1,2]', 'utf8');
    assert.deepEqual(readJsonFile(array), { ok: false, error: 'invalid_shape' });
  });
});

test('a failed write reports the reason instead of throwing', () => {
  withTempDir((dir) => {
    // The parent exists as a FILE, so mkdir of the directory fails.
    writeFileSync(join(dir, 'blocked'), 'x', 'utf8');
    const wrote = writeJsonAtomic(join(dir, 'blocked', 'record.json'), { a: 1 });
    assert.equal(wrote.ok, false);
    assert.ok(wrote.error.length > 0);
  });
});
