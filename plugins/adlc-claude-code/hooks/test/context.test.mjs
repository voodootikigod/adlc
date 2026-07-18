// context.test.mjs — T52: the compaction-aware ticket-context re-injection hook.
// Drives the real hook entrypoint as a subprocess (the hook is a script, not an
// importable module — same convention as rails.test.mjs/review.test.mjs).
//
// Mirrors plugins/adlc-codex/hooks/adlc-lifecycle.mjs's `context` mode: same
// summary shape, wired to SessionStart/PreCompact/PostCompact/SubagentStart/
// SubagentStop so a compaction or subagent boundary doesn't silently drop
// rail-protection awareness.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-hook.mjs');

function runContext(ticketsJson, currentTicket, { eventName = 'PreCompact' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cc-context-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    if (ticketsJson !== null) writeFileSync(join(dir, '.adlc', 'tickets.json'), ticketsJson);
    if (currentTicket !== null) writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify(currentTicket));
    const input = JSON.stringify({ cwd: dir, hook_event_name: eventName });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'context'], { input, encoding: 'utf8' });
    } catch (e) {
      out = e.stdout ?? '';
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('no .adlc/ — silent, no output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cc-context-noadlc-'));
  try {
    const input = JSON.stringify({ cwd: dir, hook_event_name: 'PreCompact' });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'context'], { input, encoding: 'utf8' });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.equal(out.trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no current-ticket.json — silent, no output', () => {
  const out = runContext(JSON.stringify({ tickets: [] }), null);
  assert.equal(out.trim(), '');
});

test('current ticket with rails — surfaces id, title, rail-protection status, scope', () => {
  const out = runContext(
    JSON.stringify({ tickets: [{ id: 'T50', title: 'Test ticket', rails: ['a/**'], scope: ['b/**'] }] }),
    { id: 'T50' },
  );
  const parsed = JSON.parse(out);
  assert.match(parsed.systemMessage, /ADLC current ticket: T50 — Test ticket/);
  assert.match(parsed.systemMessage, /rail protection auto-active/);
  assert.match(parsed.systemMessage, /b\/\*\*/);
  assert.match(parsed.systemMessage, /manifest\.jsonl as gate truth/);
});

test('current ticket with no rails — status reads "no rails declared"', () => {
  const out = runContext(JSON.stringify({ tickets: [{ id: 'T1', title: 'x', rails: [] }] }), { id: 'T1' });
  const parsed = JSON.parse(out);
  assert.match(parsed.systemMessage, /no rails declared/);
});

test('completed ticket — status reads "completed"', () => {
  const out = runContext(JSON.stringify({ tickets: [{ id: 'T1', title: 'x', completed: true, rails: ['a/**'] }] }), { id: 'T1' });
  const parsed = JSON.parse(out);
  assert.match(parsed.systemMessage, /Status: completed/);
});

test('current ticket id not in the store — advisory notice, not a crash', () => {
  const out = runContext(JSON.stringify({ tickets: [] }), { id: 'T99' });
  const parsed = JSON.parse(out);
  assert.match(parsed.systemMessage, /T99 is not present in the ticket store/);
});

test('hookSpecificOutput.hookEventName reflects the actual firing event (SubagentStop, not hardcoded SessionStart)', () => {
  const out = runContext(
    JSON.stringify({ tickets: [{ id: 'T1', title: 'x', rails: [] }] }),
    { id: 'T1' },
    { eventName: 'SubagentStop' },
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SubagentStop');
});

test('malformed current-ticket.json — silent (advisory, never crashes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cc-context-malformed-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), 'not json at all');
    const input = JSON.stringify({ cwd: dir, hook_event_name: 'PreCompact' });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'context'], { input, encoding: 'utf8' });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.equal(out.trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
