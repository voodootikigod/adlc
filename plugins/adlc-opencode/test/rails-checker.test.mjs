// rails-checker.test.mjs — AC3 enforcement proof for the OpenCode rails guard.
// Exercises the pure decision (checkRail) and the REAL exported
// tool.execute.before handler against representative payloads. Offline, no
// opencode binary, leaves no trace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRail, resolveActiveTicketId, probeEnforcementCapability } from '../rails-checker.mjs';
import { adlcRailsGuard } from '../index.mjs';

function repo({ tickets, current } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-rails-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  if (tickets !== undefined) writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify(tickets));
  if (current !== undefined) writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify(current));
  return dir;
}
const ON = { ADLC_P4_ENFORCEMENT: '1' };
const T1_RAILED = { tickets: [{ id: 'T1', rails: ['test/**'] }] };

// ---- (a) no-op when .adlc/tickets.json absent ----
test('a: no tickets.json → allow (no-op)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-rails-'));
  try {
    const r = checkRail({ filePath: 'test/x.mjs', tool: 'edit', root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (b) no-op when ADLC_P4_ENFORCEMENT != '1' ----
test('b: enforcement off → allow even on a declared rail', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkRail({ filePath: 'test/x.mjs', tool: 'edit', root: dir, env: { ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (c) no-op when no active ticket ----
test('c: no active ticket → allow', () => {
  const dir = repo({ tickets: T1_RAILED });
  try {
    const r = checkRail({ filePath: 'test/x.mjs', tool: 'edit', root: dir, env: { ...ON } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (d) DENY edit AND write to the active ticket's declared rail ----
for (const tool of ['edit', 'write']) {
  test(`d: ${tool} to a declared rail → deny`, () => {
    const dir = repo({ tickets: T1_RAILED });
    try {
      const r = checkRail({ filePath: 'test/x.mjs', tool, root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
      assert.equal(r.decision, 'deny');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// ---- (e) DENY edit to .adlc/tickets.json (trust root) even when not declared ----
test('e: edit .adlc/tickets.json (trust root) → deny even when rails do not list it', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['src/**'] }] } });
  try {
    const r = checkRail({ filePath: '.adlc/tickets.json', tool: 'edit', root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (f) a DIFFERENT ticket's rail does NOT block (scope = active ticket only) ----
test('f: another ticket\'s rail does not block (single-active-ticket scope)', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', rails: ['a/**'] }, { id: 'T2', rails: ['b/**'] }] } });
  try {
    const r = checkRail({ filePath: 'b/x.mjs', tool: 'edit', root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (g) conflicting ADLC_TICKET vs current-ticket.json fails closed ----
test('g: conflicting ADLC_TICKET vs current-ticket.json → deny (fail closed)', () => {
  const dir = repo({ tickets: T1_RAILED, current: { id: 'T2' } });
  try {
    const r = checkRail({ filePath: 'unrelated/x.mjs', tool: 'edit', root: dir, env: { ...ON, ADLC_TICKET: 'T1' } });
    assert.equal(r.decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(resolveActiveTicketId(dir, {}).conflict, false); // sanity: no env, dir gone is fine
});

// ---- (h) capability gate: advisory vs fail-closed via the REAL handler ----
test('h: handler throws to enforce when SDK honors deny', async () => {
  const dir = repo({ tickets: T1_RAILED });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    process.env.ADLC_OPENCODE_ENFORCES = '1';
    delete process.env.ADLC_ALLOW_ADVISORY_HOOKS;
    const hooks = await adlcRailsGuard({ worktree: dir });
    await assert.rejects(() => hooks['tool.execute.before']({ tool: 'edit', args: { filePath: 'test/x.mjs' } }));
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('h: no deny capability + advisory NOT allowed → fail closed (handler throws)', async () => {
  const dir = repo({ tickets: T1_RAILED });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    process.env.ADLC_OPENCODE_ENFORCES = '0';
    delete process.env.ADLC_ALLOW_ADVISORY_HOOKS;
    const hooks = await adlcRailsGuard({ worktree: dir });
    await assert.rejects(() => hooks['tool.execute.before']({ tool: 'edit', args: { filePath: 'test/x.mjs' } }));
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('h: no deny capability + advisory ALLOWED → advisory (handler does not throw)', async () => {
  const dir = repo({ tickets: T1_RAILED });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    process.env.ADLC_OPENCODE_ENFORCES = '0';
    process.env.ADLC_ALLOW_ADVISORY_HOOKS = '1';
    const hooks = await adlcRailsGuard({ worktree: dir });
    await hooks['tool.execute.before']({ tool: 'edit', args: { filePath: 'test/x.mjs' } }); // resolves, no throw
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('h: probeEnforcementCapability honors explicit flags', () => {
  assert.equal(probeEnforcementCapability(null, { ADLC_OPENCODE_ENFORCES: '1' }), true);
  assert.equal(probeEnforcementCapability(null, { ADLC_OPENCODE_ENFORCES: '0' }), false);
  assert.equal(probeEnforcementCapability(null, {}), false);
});
