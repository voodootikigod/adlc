// AC1 — renderWidgetLines is a pure function: no pi imports, deterministic,
// and it never emits 'NaN%', over-long lines, or a widget for an inert session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWidgetLines, WIDGET_MAX_LINE } from '../lib/widget.mjs';

test('AC1: active ticket with percent → header names ticket, state, ctx%', () => {
  const lines = renderWidgetLines({
    ticketId: 'T24',
    ticketTitle: 'Command surface',
    enforcement: 'active',
    contextPercent: 41,
    degraded: false,
    lastGateEvent: null,
  });
  assert.equal(lines[0], 'ADLC ▸ T24 (active) · ctx 41%');
  assert.equal(lines[1], 'Command surface');
  assert.equal(lines.length, 2);
});

test('AC1: error enforcement renders (error), not (active)', () => {
  const lines = renderWidgetLines({ ticketId: 'T9', enforcement: 'error', contextPercent: null });
  assert.equal(lines[0], 'ADLC ▸ T9 (error)');
});

test('AC1: missing percent is omitted, never "NaN%"', () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
    const lines = renderWidgetLines({ ticketId: 'T1', enforcement: 'active', contextPercent: bad });
    assert.ok(!lines[0].includes('NaN'), `no NaN for ${bad}`);
    assert.ok(!/ctx/.test(lines[0]), `ctx omitted for ${bad}: ${lines[0]}`);
  }
});

test('AC1: percent is rounded', () => {
  const lines = renderWidgetLines({ ticketId: 'T1', enforcement: 'active', contextPercent: 40.7 });
  assert.match(lines[0], /ctx 41%/);
});

test('AC1: degraded flag surfaces on the header line', () => {
  const lines = renderWidgetLines({ ticketId: 'T1', enforcement: 'active', contextPercent: 50, degraded: true });
  assert.match(lines[0], /· degraded/);
});

test('AC1: last gate event becomes a trailing line', () => {
  const lines = renderWidgetLines({
    ticketId: 'T1',
    enforcement: 'active',
    contextPercent: 10,
    lastGateEvent: { type: 'rail-deny', summary: 'src/x.ts' },
  });
  assert.equal(lines[lines.length - 1], 'last gate: rail-deny src/x.ts');
});

test('AC1: gate event without a summary still renders the type', () => {
  const lines = renderWidgetLines({
    ticketId: 'T1',
    enforcement: 'active',
    lastGateEvent: { type: 'shell-deny', summary: '' },
  });
  assert.equal(lines[lines.length - 1], 'last gate: shell-deny');
});

test('AC1: no ticket id → no widget (empty array to clear)', () => {
  assert.deepEqual(renderWidgetLines({ ticketId: null }), []);
  assert.deepEqual(renderWidgetLines({ ticketId: '' }), []);
  assert.deepEqual(renderWidgetLines({}), []);
});

test('AC1: at most three lines', () => {
  const lines = renderWidgetLines({
    ticketId: 'T1',
    ticketTitle: 'A title',
    enforcement: 'active',
    contextPercent: 12,
    degraded: true,
    lastGateEvent: { type: 'suppression-revert', summary: 'src/a.ts' },
  });
  assert.ok(lines.length <= 3, `got ${lines.length}`);
});

test('AC1: long title is truncated to ≤ WIDGET_MAX_LINE with an ellipsis', () => {
  const longTitle = 'x'.repeat(200);
  const lines = renderWidgetLines({ ticketId: 'T1', ticketTitle: longTitle, enforcement: 'active' });
  const titleLine = lines[1];
  assert.ok(titleLine.length <= WIDGET_MAX_LINE, `title line ${titleLine.length} chars`);
  assert.ok(titleLine.endsWith('…'), 'truncated with ellipsis');
});

test('AC1: a long ticket id/gate line stays ≤ WIDGET_MAX_LINE', () => {
  const lines = renderWidgetLines({
    ticketId: 'T1',
    enforcement: 'active',
    contextPercent: 12,
    lastGateEvent: { type: 'bash-rail-revert', summary: 'a/'.repeat(120) + 'file.ts' },
  });
  for (const line of lines) {
    assert.ok(line.length <= WIDGET_MAX_LINE, `line over cap: ${line.length}`);
  }
});

// =========================================================================
// #927/#936 — pendingAcceptance and P7 stale signals on the third line.
// Priority: pendingAcceptance > p7StaleDays > lastGateEvent. Cap 3, truncate.
// =========================================================================

test('pendingAcceptance: claim-done-no-accept renders the third line', () => {
  const lines = renderWidgetLines({
    ticketId: 'T1',
    enforcement: 'active',
    pendingAcceptance: true,
  });
  assert.equal(lines[lines.length - 1], 'P6 pending: run /adlc-accept');
});

test('pendingAcceptance beats p7Stale and lastGateEvent', () => {
  const lines = renderWidgetLines({
    ticketId: 'T1',
    enforcement: 'active',
    pendingAcceptance: true,
    p7StaleDays: 30,
    lastGateEvent: { type: 'rail-deny', summary: 'x' },
  });
  assert.equal(lines[lines.length - 1], 'P6 pending: run /adlc-accept');
});

test('p7StaleDays renders when no pendingAcceptance; beats lastGateEvent', () => {
  const lines = renderWidgetLines({
    ticketId: 'T1',
    enforcement: 'active',
    p7StaleDays: 21,
    lastGateEvent: { type: 'rail-deny', summary: 'x' },
  });
  assert.equal(lines[lines.length - 1], 'P7 stale: lesson-foundry/skill-rot 21d ago');
});

test('p7StaleDays omitted when not a positive finite number', () => {
  const lines = renderWidgetLines({
    ticketId: 'T1',
    enforcement: 'active',
    p7StaleDays: NaN,
    lastGateEvent: { type: 'rail-deny', summary: 'x' },
  });
  assert.match(lines[lines.length - 1], /last gate:/);
});

test('widget cap still 3 lines with the new signals', () => {
  const lines = renderWidgetLines({
    ticketId: 'T1',
    ticketTitle: 'Long ticket title',
    enforcement: 'active',
    pendingAcceptance: true,
    p7StaleDays: 99,
    lastGateEvent: { type: 'x', summary: 'y' },
  });
  assert.ok(lines.length <= 3);
});

test('p7StaleDays boundary: 0 suppresses, 1 renders (off-by-one kill)', () => {
  const suppressed = renderWidgetLines({ ticketId: 'T1', enforcement: 'active', p7StaleDays: 0 });
  assert.ok(!suppressed.some((l) => /P7 stale:/.test(l)), '0 days is not stale');
  const rendered = renderWidgetLines({ ticketId: 'T1', enforcement: 'active', p7StaleDays: 1 });
  assert.ok(rendered.some((l) => /P7 stale: lesson-foundry\/skill-rot 1d ago/.test(l)), '1 day renders');
});

test('pendingAcceptance false falls through to lastGateEvent', () => {
  const lines = renderWidgetLines({
    ticketId: 'T1',
    enforcement: 'active',
    pendingAcceptance: false,
    lastGateEvent: { type: 'rail-deny', summary: 'x.ts' },
  });
  assert.match(lines[lines.length - 1], /last gate:/);
});

test('AC1: purity — same input, same output, input not mutated', () => {
  const state = Object.freeze({ ticketId: 'T1', enforcement: 'active', contextPercent: 33 });
  const a = renderWidgetLines(state);
  const b = renderWidgetLines(state);
  assert.deepEqual(a, b);
});
