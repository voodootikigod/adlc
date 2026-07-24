// RAIL (t-herdr-5): frozen contract for lib/event-plan.mjs — the pure decision
// logic behind bin/on-event.mjs. Given a herdr event name + parsed payload +
// injected repo-state readers, planEvent returns exactly one plan:
//   { kind: 'clear-pane', paneId }
//   { kind: 'notify', title, body, sound }
//   { kind: 'none', reason }
// Invariants (plan §5.4, §6): fail closed on malformed/unknown input (→ none);
// advisory only (never a write, never a spawn — the plan is data the glue
// renders through the sanitizer + trusted argvs); agent-idle nudges dedupe so a
// status flap can't spam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planEvent } from '../lib/event-plan.mjs';

// A deps object with sensible defaults; override per test.
const deps = (over = {}) => ({
  resolveRepoForPane: async () => '/repo',
  listTicketIds: async () => [],
  readActiveTicket: () => ({ state: 'absent' }),
  hasCurrentTicket: () => false,
  seen: () => false,
  markSeen: () => {},
  ...over,
});

// ---- dispatch / fail-closed ----

test('an unknown event name plans nothing', async () => {
  const plan = await planEvent('some.unknown.event', { data: {} }, deps());
  assert.equal(plan.kind, 'none');
});

test('a malformed payload (non-object / missing data) fails closed to none', async () => {
  for (const bad of [null, undefined, 42, 'x', {}, { data: null }]) {
    const plan = await planEvent('pane.exited', bad, deps());
    assert.equal(plan.kind, 'none', `payload ${JSON.stringify(bad)} must plan none`);
  }
});

// ---- pane.exited ----

test('pane.exited plans a token clear for the exited pane', async () => {
  const plan = await planEvent('pane.exited', { data: { pane_id: 'w4:p2' } }, deps());
  assert.deepEqual(plan, { kind: 'clear-pane', paneId: 'w4:p2' });
});

test('pane.exited with a hostile pane id fails closed (no clear)', async () => {
  const plan = await planEvent('pane.exited', { data: { pane_id: 'w4:p2; rm -rf /' } }, deps());
  assert.equal(plan.kind, 'none');
});

// ---- worktree.created ----

const wtPayload = (label, repoRoot = '/repo') => ({
  data: { workspace: { workspace_id: 'w9', label, worktree: { repo_root: repoRoot, checkout_path: repoRoot } } },
});

test('worktree.created nudges when the branch matches a ticket id and no pointer exists', async () => {
  const plan = await planEvent('worktree.created', wtPayload('t-herdr-9'), deps({
    listTicketIds: async () => ['t-herdr-9', 't-other'],
    hasCurrentTicket: () => false,
  }));
  assert.equal(plan.kind, 'notify');
  assert.ok(plan.body.includes('t-herdr-9'));
  assert.ok(!/rm |;|\x1b/.test(plan.body));
});

test('worktree.created plans nothing when a current-ticket pointer already exists', async () => {
  const plan = await planEvent('worktree.created', wtPayload('t-herdr-9'), deps({
    listTicketIds: async () => ['t-herdr-9'],
    hasCurrentTicket: () => true, // already seeded — do not nag
  }));
  assert.equal(plan.kind, 'none');
});

test('worktree.created plans nothing when the branch matches no ticket', async () => {
  const plan = await planEvent('worktree.created', wtPayload('feature-x'), deps({
    listTicketIds: async () => ['t-herdr-9'],
  }));
  assert.equal(plan.kind, 'none');
});

test('worktree.created never AUTO-WRITES — it only ever plans a notify (advisory §5.4)', async () => {
  const plan = await planEvent('worktree.created', wtPayload('t-herdr-9'), deps({
    listTicketIds: async () => ['t-herdr-9'],
  }));
  assert.notEqual(plan.kind, 'seed');       // there is no write plan
  assert.notEqual(plan.kind, 'clear-pane');
  assert.equal(plan.kind, 'notify');
});

test('worktree.created fails closed on a missing/garbage repo root', async () => {
  const plan = await planEvent('worktree.created', { data: { workspace: { label: 't-herdr-9' } } }, deps({
    listTicketIds: async () => ['t-herdr-9'],
  }));
  assert.equal(plan.kind, 'none');
});

// ---- pane.agent_status_changed ----

const statusPayload = (status, paneId = 'w4:p2') => ({ data: { pane_id: paneId, agent_status: status, agent: 'claude' } });

test('agent going idle with an active ticket nudges to gate it', async () => {
  const plan = await planEvent('pane.agent_status_changed', statusPayload('idle'), deps({
    readActiveTicket: () => ({ state: 'active', id: 't-herdr-9' }),
    seen: () => false,
  }));
  assert.equal(plan.kind, 'notify');
  assert.ok(plan.body.includes('t-herdr-9'));
});

test('agent going "done" also nudges', async () => {
  const plan = await planEvent('pane.agent_status_changed', statusPayload('done'), deps({
    readActiveTicket: () => ({ state: 'active', id: 't-x' }),
  }));
  assert.equal(plan.kind, 'notify');
});

test('a non-idle status (working) plans nothing', async () => {
  const plan = await planEvent('pane.agent_status_changed', statusPayload('working'), deps({
    readActiveTicket: () => ({ state: 'active', id: 't-x' }),
  }));
  assert.equal(plan.kind, 'none');
});

test('agent idle with NO active ticket plans nothing (nothing to gate)', async () => {
  const plan = await planEvent('pane.agent_status_changed', statusPayload('idle'), deps({
    readActiveTicket: () => ({ state: 'absent' }),
  }));
  assert.equal(plan.kind, 'none');
});

test('a repeated (pane, ticket, status) is deduped — no second nudge, and markSeen is called on the first', async () => {
  const marks = [];
  const base = deps({
    readActiveTicket: () => ({ state: 'active', id: 't-x' }),
    seen: (key) => marks.includes(key),
    markSeen: (key) => marks.push(key),
  });
  const first = await planEvent('pane.agent_status_changed', statusPayload('idle'), base);
  assert.equal(first.kind, 'notify');
  assert.equal(marks.length, 1, 'the first nudge records a dedupe marker');
  const second = await planEvent('pane.agent_status_changed', statusPayload('idle'), base);
  assert.equal(second.kind, 'none', 'the same idle transition must not nudge twice');
});
