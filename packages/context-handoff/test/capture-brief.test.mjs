// capture-brief.test.mjs — the deterministic brief (spec §Capture).
//
// The brief IS the content_hash preimage, so its determinism is a security
// property, not a style preference: a body that differs between two runs over
// the same inputs cannot be re-verified by anyone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeBrief } from '../lib/brief.mjs';
import { hashCaptureBody } from '../lib/capture.mjs';

const FULL = {
  ticketId: 'T-155',
  ticketTitle: 'Ship the handoff continuation',
  evidenceTail: ['seq=7 gate=context-handoff-write ts=2026-08-13T00:00:00.000Z', 'seq=8 gate=rails-guard'],
  gitBranch: 'feat/continue',
  gitStatus: [' M packages/context-handoff/lib/capture.mjs', '?? notes.md'],
  flailSignals: ['repeated_error: ENOENT capture.mjs'],
  modelNarrative: 'I was mid-way through wiring the CLI.',
};

test('the same inputs always compose the same bytes', () => {
  assert.equal(composeBrief(FULL), composeBrief({ ...FULL }));
  assert.equal(hashCaptureBody(composeBrief(FULL)), hashCaptureBody(composeBrief({ ...FULL })));
});

test('every section is present even with nothing to report', () => {
  const empty = composeBrief();
  for (const heading of ['## Ticket', '## State', '## Evidence', '## Model handoff']) {
    assert.ok(empty.includes(heading), `${heading} must always be emitted`);
  }
  // An omitted section reads as "the composer did not know about this", which is
  // a different claim from "there was nothing".
  assert.match(empty, /- id: _none_/);
  assert.match(empty, /## Model handoff\n\n_none_/);
  assert.equal(composeBrief(), composeBrief({ evidenceTail: [], gitStatus: [], flailSignals: [] }));
});

test('sections keep a stable order so a reader (and a diff) can rely on it', () => {
  const brief = composeBrief(FULL);
  const order = ['## Ticket', '## State', '## Evidence', '## Model handoff'].map((h) => brief.indexOf(h));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((i) => i >= 0));
});

test('every input reaches the body', () => {
  const brief = composeBrief(FULL);
  assert.match(brief, /- id: T-155/);
  assert.match(brief, /- title: Ship the handoff continuation/);
  assert.match(brief, /- branch: feat\/continue/);
  assert.ok(brief.includes('?? notes.md'));
  assert.ok(brief.includes('repeated_error: ENOENT capture.mjs'));
  assert.ok(brief.includes('seq=8 gate=rails-guard'));
  assert.ok(brief.includes('I was mid-way through wiring the CLI.'));
});

test('multi-line strings and arrays are accepted alike', () => {
  const asArray = composeBrief({ ...FULL, gitStatus: [' M a.mjs', ' M b.mjs'] });
  const asString = composeBrief({ ...FULL, gitStatus: ' M a.mjs\n M b.mjs\n' });
  assert.equal(asArray, asString);
});

test('a blank narrative is reported as none rather than as an empty section', () => {
  assert.match(composeBrief({ ...FULL, modelNarrative: '   \n' }), /## Model handoff\n\n_none_/);
  assert.match(composeBrief({ ...FULL, modelNarrative: null }), /## Model handoff\n\n_none_/);
});

test('the composer reads nothing from the clock or the environment', () => {
  // A timestamp would move the hash on every run and make the bind
  // unreproducible — assert the output carries no time-of-composition.
  const year = String(new Date().getFullYear());
  const brief = composeBrief({ ...FULL, evidenceTail: [], flailSignals: [] });
  assert.ok(!brief.includes(year), 'the brief must not stamp itself with the current time');
});
