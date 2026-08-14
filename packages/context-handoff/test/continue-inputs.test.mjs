// continue-inputs.test.mjs — the impure half of the brief: git state, the
// evidence tail, the ticket title, and the bounded transcript read.
//
// Every reader here is best-effort by design, so the tests carry the burden of
// saying what "best effort" means: bounded output, the RECENT end of the ledger,
// and a null rather than a throw when the world is not cooperating.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EVIDENCE_TAIL_ENTRIES,
  GIT_STATUS_MAX_LINES,
  evidenceTail,
  gitState,
  readTranscriptTail,
  ticketTitle,
} from '../lib/continue-inputs.mjs';

function withTempRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-inputs-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A ledger of `count` entries, oldest first — only the tail should survive. */
function seedManifest(adlcDir, count) {
  mkdirSync(adlcDir, { recursive: true });
  const lines = [];
  for (let seq = 1; seq <= count; seq += 1) {
    lines.push(JSON.stringify({ seq, gate: `gate-${seq}`, ts: `2026-08-13T00:00:${String(seq).padStart(2, '0')}.000Z`, ticket: 'T155', data: {}, files: {}, prev: null }));
  }
  writeFileSync(join(adlcDir, 'manifest.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

test('the evidence tail carries the last 12 entries, newest end first-hand', () => {
  withTempRoot((root) => {
    const adlcDir = join(root, '.adlc');
    seedManifest(adlcDir, 30);
    const tail = evidenceTail(adlcDir);
    // Spelled out rather than read from the module: a bound asserted against
    // its own constant cannot notice the constant moving.
    assert.equal(EVIDENCE_TAIL_ENTRIES, 12);
    assert.equal(tail.length, 12);
    assert.match(tail[0], /seq=19 gate=gate-19/);
    assert.match(tail.at(-1), /seq=30 gate=gate-30/);
    assert.ok(tail.every((line) => line.includes('ticket=T155')));
  });
});

test('a short or unreadable ledger yields an empty tail rather than throwing', () => {
  withTempRoot((root) => {
    const adlcDir = join(root, '.adlc');
    assert.deepEqual(evidenceTail(adlcDir), []);
    seedManifest(adlcDir, 2);
    assert.equal(evidenceTail(adlcDir).length, 2);
    assert.equal(evidenceTail(adlcDir, { limit: 1 }).length, 1);
  });
});

test('git state is bounded and says how much it left out', () => {
  const lines = Array.from({ length: 45 }, (_, i) => ` M file-${i}.mjs`);
  const state = gitState('/repo', {
    run: (_root, args) => (args[0] === 'rev-parse' ? 'feat/continue\n' : `${lines.join('\n')}\n`),
  });
  assert.equal(state.branch, 'feat/continue');
  assert.equal(GIT_STATUS_MAX_LINES, 40);
  assert.equal(state.status.length, 41, '40 paths plus the summary line');
  assert.equal(state.status[0], ' M file-0.mjs');
  assert.equal(state.status[39], ' M file-39.mjs');
  assert.equal(state.status.at(-1), '… 5 more changed path(s)');
});

test('git state reports nothing rather than failing when git cannot answer', () => {
  const dead = gitState('/repo', { run: () => null });
  assert.deepEqual(dead, { branch: null, status: [] });
  const clean = gitState('/repo', { run: (_r, args) => (args[0] === 'rev-parse' ? 'main\n' : '') });
  assert.deepEqual(clean, { branch: 'main', status: [] });
});

test('a small transcript is read whole, with the mtime staleness falls back to', () => {
  withTempRoot((root) => {
    const path = join(root, 't.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2}\n', 'utf8');
    const got = readTranscriptTail(path);
    assert.equal(got.ok, true);
    assert.equal(got.text, '{"a":1}\n{"b":2}\n');
    assert.equal(got.truncated, false);
    // The mtime is the only age evidence for a transcript whose entries carry
    // no timestamp, so the reader has to surface it.
    assert.equal(typeof got.mtimeMs, 'number');
    assert.ok(Math.abs(got.mtimeMs - Date.now()) < 60_000);
  });
});

test('a large transcript is read from the end, dropping the partial first line', () => {
  withTempRoot((root) => {
    const path = join(root, 'big.jsonl');
    const filler = `${JSON.stringify({ pad: 'z'.repeat(200) })}\n`;
    writeFileSync(path, `${filler.repeat(60)}${JSON.stringify({ tail: 'last' })}\n`, 'utf8');

    const got = readTranscriptTail(path, { maxBytes: 500 });
    assert.equal(got.ok, true);
    assert.equal(got.truncated, true);
    assert.ok(got.text.includes('"tail":"last"'), 'the end of the file is what matters');
    assert.ok(Buffer.byteLength(got.text, 'utf8') <= 500);
    // Every surviving line must be whole, or the JSONL parser sees garbage.
    for (const line of got.text.split('\n').filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line), `partial line survived: ${line}`);
    }
  });
});

test('a missing path, a directory, and an unreadable source all fail soft', () => {
  withTempRoot((root) => {
    assert.equal(readTranscriptTail(join(root, 'nope.jsonl')).ok, false);
    assert.deepEqual(readTranscriptTail(root), { ok: false, error: 'not_a_file' });
  });
});

test('a window smaller than the final line yields no usable text rather than half a line', () => {
  withTempRoot((root) => {
    const path = join(root, 'one-line.jsonl');
    writeFileSync(path, `${JSON.stringify({ only: 'z'.repeat(300) })}\n`, 'utf8');
    const got = readTranscriptTail(path, { maxBytes: 50 });
    assert.equal(got.ok, true);
    assert.equal(got.text, '', 'half a JSON object is worse than nothing');
  });
});

test('the ticket title is best-effort and never throws on a storeless repo', () => {
  withTempRoot((root) => {
    const adlcDir = join(root, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    assert.equal(ticketTitle(adlcDir, 'T155'), null);
    assert.equal(ticketTitle(adlcDir, null), null);

    writeFileSync(
      join(adlcDir, 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T155', title: 'Ship the continuation', body: 'b', scope: [] }] }),
      'utf8',
    );
    assert.equal(ticketTitle(adlcDir, 'T155'), 'Ship the continuation');
    assert.equal(ticketTitle(adlcDir, 'T-absent'), null);
  });
});
