// continue-evidence-tail.test.mjs — the evidence tail is bounded BEFORE the
// parse, not after.
//
// The forest read parses the root ledger and every segment to produce a fully
// ordered history, then this took the last twelve lines of it. That makes a
// brief's cost grow with the repo's whole history and makes its content depend
// on files the command has no reason to open. The fixtures below poison the
// files that must never be read, so "we only read the newest chain" is
// observable rather than asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EVIDENCE_TAIL_BYTES,
  EVIDENCE_TAIL_ENTRIES,
  evidenceTail,
  newestManifestChain,
} from '../lib/continue-inputs.mjs';

function withLedger(fn) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-evidence-'));
  const adlcDir = join(root, '.adlc');
  mkdirSync(adlcDir, { recursive: true });
  try {
    return fn(adlcDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const entryLine = (seq, gate) =>
  JSON.stringify({ seq, gate, ts: `2026-08-14T00:00:${String(seq % 60).padStart(2, '0')}.000Z`, ticket: 'T155' });

function writeChain(path, from, to, gate = 'build') {
  const lines = [];
  for (let seq = from; seq <= to; seq += 1) lines.push(entryLine(seq, `${gate}-${seq}`));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

test('with no segments the root ledger is the chain', () => {
  withLedger((adlcDir) => {
    writeChain(join(adlcDir, 'manifest.jsonl'), 1, 3);
    assert.equal(newestManifestChain(adlcDir), join(adlcDir, 'manifest.jsonl'));
    const tail = evidenceTail(adlcDir);
    assert.equal(tail.length, 3);
    assert.match(tail[0], /seq=1 gate=build-1/);
  });
});

test('an empty ledger directory yields no tail rather than throwing', () => {
  withLedger((adlcDir) => {
    assert.equal(newestManifestChain(adlcDir), null);
    assert.deepEqual(evidenceTail(adlcDir), []);
  });
});

test('a forest of exactly one segment is a forest, not a fallback to the root', () => {
  withLedger((adlcDir) => {
    // The boundary the multi-segment fixtures cannot see: with ONE segment,
    // a `length > 1` slip silently reads the (poisoned) root instead.
    writeFileSync(
      join(adlcDir, 'manifest.jsonl'),
      `${JSON.stringify({ seq: 1, gate: 'POISONED-ROOT', ts: 'x', ticket: 'T0' })}\n`,
      'utf8',
    );
    writeChain(join(adlcDir, 'manifest.d', 'only-01AAAAAAAAAAAAAAAAAAAAAAAA.jsonl'), 1, 2, 'only');

    assert.match(newestManifestChain(adlcDir), /only-01AAAAAAAAAAAAAAAAAAAAAAAA\.jsonl$/);
    for (const line of evidenceTail(adlcDir)) {
      assert.ok(!line.includes('POISONED'), `the root was read past a lone segment: ${line}`);
    }
  });
});

test('the newest segment is read and older chains are never opened', () => {
  withLedger((adlcDir) => {
    // A root ledger whose content would be catastrophic to quote, and an older
    // segment likewise. If either is parsed, it shows up in the tail.
    writeFileSync(
      join(adlcDir, 'manifest.jsonl'),
      `${JSON.stringify({ seq: 1, gate: 'POISONED-ROOT', ts: 'x', ticket: 'T0' })}\n`,
      'utf8',
    );
    writeChain(join(adlcDir, 'manifest.d', 'a-01AAAAAAAAAAAAAAAAAAAAAAAA.jsonl'), 1, 5, 'POISONED-OLD');
    writeChain(join(adlcDir, 'manifest.d', 'b-01ZZZZZZZZZZZZZZZZZZZZZZZZ.jsonl'), 90, 95, 'newest');

    assert.match(newestManifestChain(adlcDir), /b-01ZZZZZZZZZZZZZZZZZZZZZZZZ\.jsonl$/);
    const tail = evidenceTail(adlcDir);
    assert.equal(tail.length, 6);
    for (const line of tail) {
      assert.ok(!line.includes('POISONED'), `an older chain was read: ${line}`);
      assert.match(line, /gate=newest-/);
    }
  });
});

test('a short newest segment yields fewer entries rather than reaching back', () => {
  withLedger((adlcDir) => {
    // The documented trade: the brief carries less context rather than the
    // command walking the whole forest to fill its quota.
    writeChain(join(adlcDir, 'manifest.d', 'a-01AAAAAAAAAAAAAAAAAAAAAAAA.jsonl'), 1, 50, 'older');
    writeChain(join(adlcDir, 'manifest.d', 'b-01ZZZZZZZZZZZZZZZZZZZZZZZZ.jsonl'), 90, 91, 'newest');

    const tail = evidenceTail(adlcDir);
    assert.equal(tail.length, 2, 'two entries, not twelve borrowed from the older segment');
    assert.ok(tail.every((line) => line.includes('gate=newest-')));
  });
});

test('a long chain is capped at the newest entries', () => {
  withLedger((adlcDir) => {
    writeChain(join(adlcDir, 'manifest.jsonl'), 1, 400);
    const tail = evidenceTail(adlcDir);
    assert.equal(EVIDENCE_TAIL_ENTRIES, 12);
    assert.equal(tail.length, 12);
    assert.match(tail.at(-1), /seq=400 /);
    assert.match(tail[0], /seq=389 /);
  });
});

test('the read window is 64 KiB', () => {
  // Spelled out rather than compared to itself: a window asserted against its
  // own constant moves with it, which is exactly what a widened read would do.
  assert.equal(EVIDENCE_TAIL_BYTES, 64 * 1024);
});

test('the read is byte-bounded, so a huge chain cannot be slurped', () => {
  withLedger((adlcDir) => {
    // One entry far larger than the window, followed by the entries that matter:
    // the oversized line must fall outside the tail rather than be buffered.
    const huge = JSON.stringify({ seq: 1, gate: 'HUGE', ts: 'x', pad: 'z'.repeat(64 * 1024) });
    const lines = [huge];
    for (let seq = 2; seq <= 15; seq += 1) lines.push(entryLine(seq, `late-${seq}`));
    writeFileSync(join(adlcDir, 'manifest.jsonl'), `${lines.join('\n')}\n`, 'utf8');

    const tail = evidenceTail(adlcDir);
    assert.equal(tail.length, 12);
    assert.ok(tail.every((line) => !line.includes('HUGE')), 'the oversized entry is outside the window');
  });
});

test('malformed lines are skipped, not guessed at', () => {
  withLedger((adlcDir) => {
    writeFileSync(
      join(adlcDir, 'manifest.jsonl'),
      [entryLine(1, 'ok-1'), '{not json', '[]', 'null', entryLine(2, 'ok-2'), ''].join('\n'),
      'utf8',
    );
    const tail = evidenceTail(adlcDir);
    assert.equal(tail.length, 2);
    assert.match(tail[0], /gate=ok-1/);
    assert.match(tail[1], /gate=ok-2/);
  });
});

test('a caller-supplied limit is honored', () => {
  withLedger((adlcDir) => {
    writeChain(join(adlcDir, 'manifest.jsonl'), 1, 30);
    assert.equal(evidenceTail(adlcDir, { limit: 3 }).length, 3);
    assert.equal(evidenceTail(adlcDir, { limit: 0 }).length, 0);
  });
});
