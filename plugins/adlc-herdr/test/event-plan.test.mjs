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
// listTicketIds is a FILESYSTEM read of the store (the glue never spawns a
// subprocess in the untrusted event repoRoot); claim atomically records a
// dedupe key, returning true only for the first caller (race-safe across the
// concurrent per-event processes the host spawns).
const deps = (over = {}) => ({
  resolveRepoForPane: async () => '/repo',
  listTicketIds: async () => [],
  readActiveTicket: () => ({ state: 'absent' }),
  hasCurrentTicket: () => false,
  claim: async () => true, // first claim wins by default
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

test('pane id validation accepts the full boundary char set and rejects a leading hyphen / stray char', async () => {
  // Every range endpoint must be accepted (A,Z,a,z,0,9 plus :,_ as first char,
  // and '-' in the tail), INCLUDING a mid-range digit as the first char (pins
  // the 0-9 first-class against a range-narrowing off-by-one) — each char-class
  // boundary is held against an off-by-one.
  for (const id of ['Zz09Aa', ':_A9z0', 'a:_-9Z', 'A0', 'z9', '5x7', '2:p9']) {
    assert.deepEqual(await planEvent('pane.exited', { data: { pane_id: id } }, deps()), { kind: 'clear-pane', paneId: id });
  }
  // Reject chars ADJACENT to each range endpoint (pins against a range
  // widening off-by-one): '@'<'A', '['>'Z', '`'<'a', '{'>'z', '/'<'0'.
  for (const bad of ['-w0', 'w0/p1', 'w0.p1', 'w0 p1', 'w@x', 'w[x', 'w`x', 'w{x', '@bc', '[bc']) {
    assert.equal((await planEvent('pane.exited', { data: { pane_id: bad } }, deps())).kind, 'none', `${bad} must reject`);
  }
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

test('worktree.created resolves ticket ids via the injected reader (a filesystem read, never a subprocess in the payload dir)', async () => {
  // The store reader is injected; the security property (no subprocess in an
  // untrusted cwd) is a glue guarantee, verified end-to-end in on-event-e2e.
  const seenRoots = [];
  const plan = await planEvent('worktree.created', wtPayload('t-herdr-9', '/some/repo'), deps({
    listTicketIds: async (root) => { seenRoots.push(root); return ['t-herdr-9']; },
  }));
  assert.equal(plan.kind, 'notify');
  assert.deepEqual(seenRoots, ['/some/repo'], 'the reader is called with the payload repo root');
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

test('a repeated (pane, ticket, status) is deduped via an ATOMIC claim — no second nudge', async () => {
  const claimed = new Set();
  const base = deps({
    readActiveTicket: () => ({ state: 'active', id: 't-x' }),
    // atomic claim: true only for the first caller of a key (race-safe)
    claim: async (key) => (claimed.has(key) ? false : (claimed.add(key), true)),
  });
  const first = await planEvent('pane.agent_status_changed', statusPayload('idle'), base);
  assert.equal(first.kind, 'notify');
  const second = await planEvent('pane.agent_status_changed', statusPayload('idle'), base);
  assert.equal(second.kind, 'none', 'the same idle transition must not nudge twice');
});

test('the nudge is gated on the claim WINNING — a lost claim (concurrent process) does not notify', async () => {
  const plan = await planEvent('pane.agent_status_changed', statusPayload('idle'), deps({
    readActiveTicket: () => ({ state: 'active', id: 't-x' }),
    claim: async () => false, // another process already claimed this key
  }));
  assert.equal(plan.kind, 'none');
});
