import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, toJson } from '../lib/format.mjs';

// renderReport is the human-readable (non --json) output path — bin/ticket-prune
// prints it whenever --json is absent. These tests pin its exact text so the
// literal strings (e.g. "completed:true", the empty-state lines, the ceremony
// section) can't silently drift into a display lie.

test('renderReport (write): a mixed result shows the tombstoned line, the completed:true wording, and the not-auto-tombstonable ceremony section for both blockers', () => {
  const text = renderReport({
    baseRef: 'HEAD',
    write: true,
    stale: [],
    active: [{ id: 'T9', reason: 'still building' }],
    tombstoned: [{ id: 'T1', reason: 'shipped scope' }],
    needsCeremony: [
      { id: 'T2', reason: 'shipped scope', rails: ['test/a/**', 'test/b/**'], blocker: 'rails-freeze' },
      { id: 'T3', reason: 'shipped scope', rails: [], blocker: 'preexisting-completed-field' },
    ],
  });

  assert.match(text, /Tombstoned 1 rails-less stale ticket\(s\) with completed:true in place:/);
  assert.match(text, /- T1: shipped scope/);
  assert.match(text, /Stale but not auto-tombstonable — needs the protected-base admin ceremony \(2\):/);
  // rails-freeze blocker renders the frozen globs...
  assert.match(text, /- T2: shipped scope \[freezes: test\/a\/\*\*, test\/b\/\*\*\]/);
  // ...preexisting-completed-field blocker renders the field explanation, not "freezes:".
  assert.match(text, /- T3: shipped scope \[already has a completed field\]/);
  assert.doesNotMatch(text, /- T3:.*freezes:/);
  // Active section still present.
  assert.match(text, /Active tickets \(1\):/);
  assert.match(text, /- T9: still building/);
});

test('renderReport (write): with nothing tombstoned and no ceremony items, it says so explicitly and omits the ceremony section', () => {
  const text = renderReport({
    baseRef: 'origin/main',
    write: true,
    stale: [],
    active: [],
    tombstoned: [],
    needsCeremony: [],
  });

  assert.match(text, /No stale tickets tombstoned\./);
  assert.doesNotMatch(text, /completed:true/);
  assert.doesNotMatch(text, /admin ceremony/);
  assert.match(text, /Active tickets \(0\):/);
  assert.match(text, /\(none\)/);
});

test('renderReport (dry-run): stale tickets are reported with the "re-run with --write to tombstone" hint, not archive wording', () => {
  const text = renderReport({
    baseRef: 'HEAD',
    write: false,
    stale: [{ id: 'T1', reason: 'shipped scope' }],
    active: [],
    tombstoned: [],
    needsCeremony: [],
  });

  assert.match(text, /Stale tickets \(1\) — re-run with --write to tombstone them:/);
  assert.match(text, /- T1: shipped scope/);
  assert.doesNotMatch(text, /archive/i);
});

test('renderReport (dry-run): a header reflects the dry-run mode and "No stale tickets found" when empty', () => {
  const text = renderReport({ baseRef: 'HEAD', write: false, stale: [], active: [], tombstoned: [], needsCeremony: [] });
  assert.match(text, /ticket-prune — base ref: HEAD \(dry-run\)/);
  assert.match(text, /No stale tickets found\./);
});

test('toJson projects exactly the machine-readable fields, defaulting the new arrays', () => {
  const json = toJson({ baseRef: 'HEAD', write: true, stale: [], active: [], tombstoned: [{ id: 'T1', reason: 'x' }], needsCeremony: [] });
  assert.deepEqual(json, {
    baseRef: 'HEAD',
    write: true,
    ceremony: false,
    stale: [],
    active: [],
    tombstoned: [{ id: 'T1', reason: 'x' }],
    ceremonyCompleted: [],
    needsCeremony: [],
  });
});

test('#198 renderReport (dry-run): a railed shipped ticket is listed under the ceremony section so the drift is visible without --write', () => {
  const text = renderReport({
    baseRef: 'origin/main',
    write: false,
    ceremony: false,
    stale: [{ id: 'T7', reason: 'shipped scope' }],
    active: [],
    tombstoned: [],
    ceremonyCompleted: [],
    needsCeremony: [{ id: 'T7', reason: 'shipped scope', rails: ['test/codec/**'], blocker: 'rails-freeze' }],
  });
  assert.match(text, /needs the protected-base admin ceremony \(1\):/);
  assert.match(text, /- T7: shipped scope \[freezes: test\/codec\/\*\*\]/);
});

test('#198 renderReport (ceremony): completed rail-freezing tickets render under the "Completed … via the admin ceremony" section', () => {
  const text = renderReport({
    baseRef: 'origin/main',
    write: false,
    ceremony: true,
    stale: [{ id: 'T7', reason: 'shipped scope' }],
    active: [],
    tombstoned: [],
    ceremonyCompleted: [{ id: 'T7', reason: 'shipped scope', rails: ['test/codec/**'] }],
    needsCeremony: [],
  });
  assert.match(text, /\(ceremony\)/);
  assert.match(text, /Completed 1 rail-freezing ticket\(s\) via the admin ceremony \(rails now expire, T36\):/);
  assert.match(text, /- T7: freezes test\/codec\/\*\*/);
});
