// A tracker-side issue whose adlc block has been DELETED is the maximal rail
// narrowing: every local rail is gone from the incoming side. The pull guard
// has to see that case exactly as it sees a block that omits `rails`, or the
// one edit that removes the whole block strips rails and scope with exit 0.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pull } from '../lib/pull.mjs';
import { serializeBlock } from '../lib/block.mjs';
import { canonicalHash } from '../lib/canonical.mjs';
import { loadTicketSnapshot } from '@adlc/tickets';

const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

const ID = 'gh:acme/app#1';
const hashOf = (block) => canonicalHash(block, { omit: ['$schema'] });

function repo({ ticket, baseBlock }) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-pull-absent-'));
  fixtureDirs.add(dir);
  mkdirSync(join(dir, '.adlc'));
  writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify({ ticketSync: { provider: 'github', repo: 'acme/app' } }));
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [ticket] }, null, 2));
  // base == the local block, so an absent remote block reconciles to take-remote
  // (remote changed, local did not) and reaches the adopt path under test.
  const syncedHash = baseBlock === null ? null : hashOf(baseBlock);
  writeFileSync(join(dir, '.adlc', 'ticket-sync.state.json'), JSON.stringify({
    version: 1, tickets: { [ID]: { nodeId: 'N1', syncedHash } }, pendingCreates: {},
  }));
  return dir;
}

const fakeProvider = (issues) => ({ listIssues: async () => ({ ok: true, issues }) });
const bare = (body) => ({ number: 1, nodeId: 'N1', url: 'https://github.com/acme/app/issues/1', title: 'issue 1', body, labels: [], state: 'open' });
const withBlock = (block) => bare(serializeBlock({ prefix: 'desc\n', suffix: '' }, block));
const readTicket = (dir) => loadTicketSnapshot({ root: dir }).mutableTickets().find((t) => t.id === ID);

const RAILED = { id: ID, title: 'issue 1', scope: ['src/auth/**'], rails: ['test/auth/**'], duration: 1 };
const RAILED_BLOCK = { scope: ['src/auth/**'], rails: ['test/auth/**'], duration: 1 };

// --- AC1: absent block vs a railed local ticket ---

test('AC1: a remote issue with NO adlc block cannot strip a local rail — exit 2, the block and the rail are named', async () => {
  const dir = repo({ ticket: RAILED, baseBlock: RAILED_BLOCK });
  const r = await pull({ dir, provider: fakeProvider([bare('desc only, sentinels deleted')]) });
  assert.equal(r.exitCode, 2, `expected a blocked pull: ${JSON.stringify(r)}`);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^gh:acme\/app#1: remote issue carries no adlc block — /);
  assert.match(r.errors[0], /rail removed\/replaced: test\/auth\/\*\*/);
  assert.match(r.errors[0], /rerun with --allow-rail-narrowing$/);
  assert.ok(!r.plan.some((p) => p.id === ID), 'a blocked ticket is not planned');
});

test('AC1: the same pull with --allow-rail-narrowing proceeds and the block fields are gone (explicit, not accidental)', async () => {
  const dir = repo({ ticket: RAILED, baseBlock: RAILED_BLOCK });
  const r = await pull({
    dir, provider: fakeProvider([bare('desc only, sentinels deleted')]),
    allowRailNarrowing: true, write: true, allowUnsigned: true, now: 'T',
  });
  assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
  assert.ok(r.plan.some((p) => p.id === ID && p.action === 'update' && p.decision === 'take-remote'));
  const t = readTicket(dir);
  assert.equal(t.rails, undefined);
  assert.equal(t.scope, undefined);
  assert.equal(t.duration, undefined);
});

test('AC1 (dry-run is blocked too): the guard does not depend on --write', async () => {
  const dir = repo({ ticket: RAILED, baseBlock: RAILED_BLOCK });
  const r = await pull({ dir, provider: fakeProvider([bare('x')]), write: false });
  assert.equal(r.exitCode, 2);
});

// --- AC2: absent block is not a narrowing of nothing ---

test('AC2: a local ticket with no rails and no scope is unaffected by an absent block — exit 0, no error', async () => {
  const ticket = { id: ID, title: 'issue 1', duration: 1 };
  const dir = repo({ ticket, baseBlock: { duration: 1 } });
  const r = await pull({ dir, provider: fakeProvider([bare('desc only')]) });
  assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
  assert.equal(r.errors, undefined);
  assert.ok(r.plan.some((p) => p.id === ID && p.decision === 'take-remote'));
});

test('AC2: a local ticket with no block at all and no remote block is converged (unchanged behaviour)', async () => {
  const ticket = { id: ID, title: 'issue 1' };
  const dir = repo({ ticket, baseBlock: null });
  const r = await pull({ dir, provider: fakeProvider([bare('desc only')]) });
  assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
  assert.ok(r.plan.some((p) => p.id === ID && p.decision === 'converged'));
});

// --- regression guards: the present-block paths are untouched ---

test('regression: a PRESENT block that omits rails still fails exactly as before (no new prefix)', async () => {
  const dir = repo({ ticket: RAILED, baseBlock: RAILED_BLOCK });
  const r = await pull({ dir, provider: fakeProvider([withBlock({ scope: ['src/auth/**'], duration: 1 })]) });
  assert.equal(r.exitCode, 2);
  assert.match(r.errors[0], /^gh:acme\/app#1: rail removed\/replaced: test\/auth\/\*\* — rerun with --allow-rail-narrowing$/);
});

test('regression: a present block that keeps the rails and narrows nothing is adopted', async () => {
  const dir = repo({ ticket: RAILED, baseBlock: RAILED_BLOCK });
  const r = await pull({ dir, provider: fakeProvider([withBlock({ ...RAILED_BLOCK, rails: ['test/auth/**', 'test/more/**'] })]) });
  assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
  assert.ok(r.plan.some((p) => p.id === ID && p.action === 'update'));
});

test('regression: a scope-only local ticket (no rails) is still blocked when a present block WIDENS scope', async () => {
  const ticket = { id: ID, title: 'issue 1', scope: ['src/auth/**'], duration: 1 };
  const dir = repo({ ticket, baseBlock: { scope: ['src/auth/**'], duration: 1 } });
  const r = await pull({ dir, provider: fakeProvider([withBlock({ scope: ['src/auth/**', '**'], duration: 1 })]) });
  assert.equal(r.exitCode, 2);
  assert.match(r.errors[0], /scope widened: \*\*/);
});

test('regression: keep-local (local changed, remote did not) never consults the guard even with no remote block', async () => {
  // base is an OLDER local block; the local ticket moved on; the remote block is
  // gone. remote == base? No: remote null, base non-null → both changed → conflict,
  // which is the pre-existing fail-safe and must not become a narrowing error.
  const dir = repo({ ticket: RAILED, baseBlock: { scope: ['src/old/**'], duration: 1 } });
  const r = await pull({ dir, provider: fakeProvider([bare('desc only')]) });
  assert.equal(r.exitCode, 2);
  assert.match(r.errors[0], /both local and remote changed since last sync — rerun with --force/);
  assert.doesNotMatch(r.errors[0], /no adlc block/);
});

test('regression: conflict + --force on an absent block still runs the guard (force resolves the conflict, not the rail)', async () => {
  const dir = repo({ ticket: RAILED, baseBlock: { scope: ['src/old/**'], duration: 1 } });
  const r = await pull({ dir, provider: fakeProvider([bare('desc only')]), force: true });
  assert.equal(r.exitCode, 2);
  assert.match(r.errors[0], /remote issue carries no adlc block — rail removed\/replaced: test\/auth\/\*\*/);
});
