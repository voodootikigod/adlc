// continue-staleness.test.mjs — the spec's 72h `written_at` rule, applied to
// the model narrative the transcript supplies.
//
// A days-old plan read as current is worse than no plan: the successor acts on
// intentions the repository has since moved past. So a stale narrative is
// dropped and the omission is STATED — silently shipping a shorter brief would
// leave a reader unable to tell "the session said nothing" from "we refused to
// repeat what it said".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { HANDOFF_MAX_AGE_HOURS } from '../lib/thresholds.mjs';
import { transcriptTimestamp, parseTranscript } from '../lib/transcript-extract.mjs';
import { KEYED, run, seedBoundDeny, withTempRepo } from './continue-cli-support.mjs';

const HOUR_MS = 60 * 60 * 1000;
const NARRATIVE = 'Mid-way through the gate rewrite; the rollback path is still failing.';

/** A transcript whose newest entry is `ageHours` old. */
function transcriptAged(cwd, name, ageHours) {
  const at = new Date(Date.now() - ageHours * HOUR_MS).toISOString();
  const path = join(cwd, name);
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: 'go' } }),
      JSON.stringify({
        type: 'assistant',
        requestId: 'req_1',
        timestamp: at,
        message: { role: 'assistant', content: [{ type: 'text', text: NARRATIVE }] },
      }),
    ].join('\n'),
    'utf8',
  );
  return path;
}

function captureFor(cwd, session, transcriptName) {
  seedBoundDeny(cwd, session, 'T155');
  const payload = JSON.parse(
    run(
      ['continue', '--deny-session', session, '--capture-from', transcriptName, '--write', '--json'],
      { cwd, env: KEYED },
    ).stdout,
  );
  return readFileSync(payload.content_path, 'utf8');
}

test('a transcript just inside the window keeps its narrative', () => {
  withTempRepo((cwd) => {
    transcriptAged(cwd, 'fresh.jsonl', HANDOFF_MAX_AGE_HOURS - 1);
    const body = captureFor(cwd, 'denier-fresh', 'fresh.jsonl');
    assert.ok(body.includes(NARRATIVE), 'a narrative inside the window must survive');
    assert.ok(!body.includes('source stale'));
  });
});

test('a transcript just outside the window loses it, and the brief says why', () => {
  withTempRepo((cwd) => {
    transcriptAged(cwd, 'stale.jsonl', HANDOFF_MAX_AGE_HOURS + 1);
    const body = captureFor(cwd, 'denier-stale', 'stale.jsonl');
    assert.ok(!body.includes(NARRATIVE), 'a stale narrative must not be handed on');
    assert.match(body, /model narrative omitted: source stale/);
    // Degrade, not failure: the deterministic half still ships.
    assert.match(body, /## Ticket/);
    assert.match(body, /## Evidence/);
  });
});

test('staleness is measured from the transcript, not from the file it lives in', () => {
  withTempRepo((cwd) => {
    // Freshly written FILE, days-old CONVERSATION: a copied or restored
    // transcript must not read as current just because it was touched.
    const path = transcriptAged(cwd, 'copied.jsonl', HANDOFF_MAX_AGE_HOURS + 48);
    const now = new Date();
    utimesSync(path, now, now);
    const body = captureFor(cwd, 'denier-copied', 'copied.jsonl');
    assert.ok(!body.includes(NARRATIVE));
    assert.match(body, /source stale/);
  });
});

test('a transcript with no timestamps falls back to the file mtime', () => {
  withTempRepo((cwd) => {
    const path = join(cwd, 'undated.jsonl');
    writeFileSync(
      path,
      JSON.stringify({
        type: 'assistant',
        requestId: 'req_1',
        message: { role: 'assistant', content: [{ type: 'text', text: NARRATIVE }] },
      }),
      'utf8',
    );
    const old = new Date(Date.now() - (HANDOFF_MAX_AGE_HOURS + 5) * HOUR_MS);
    utimesSync(path, old, old);

    const body = captureFor(cwd, 'denier-undated', 'undated.jsonl');
    assert.ok(!body.includes(NARRATIVE));
    assert.match(body, /source stale/);
  });
});

test('transcriptTimestamp takes the newest parseable stamp and ignores the rest', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-08-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', timestamp: 'not-a-date' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-03T00:00:00.000Z' }),
    JSON.stringify({ type: 'assistant' }),
  ].join('\n');
  const entries = parseTranscript(lines).entries;
  assert.equal(transcriptTimestamp(entries), Date.parse('2026-08-03T00:00:00.000Z'));

  assert.equal(transcriptTimestamp([]), null);
  assert.equal(transcriptTimestamp(null), null);
  assert.equal(transcriptTimestamp([{ type: 'assistant' }]), null);
  assert.equal(transcriptTimestamp([{ timestamp: 'nope' }]), null);
});
