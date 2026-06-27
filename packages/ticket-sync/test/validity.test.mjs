import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validityGate, pull } from '../lib/pull.mjs';
import { serializeBlock } from '../lib/block.mjs';
import { canonicalHash } from '../lib/canonical.mjs';

// ---- validityGate (pure) ----

test('validityGate normalizes gh ids + edge targets to lowercase', () => {
  const g = validityGate([
    { id: 'gh:Acme/App#1', title: 'a' },
    { id: 'gh:Acme/App#2', title: 'b', edges: [{ to: 'gh:ACME/app#1' }] },
  ]);
  assert.ok(g.ok, g.errors.join('; '));
  assert.deepEqual(g.tickets.map((t) => t.id), ['gh:acme/app#1', 'gh:acme/app#2']);
  assert.equal(g.tickets[1].edges[0].to, 'gh:acme/app#1');
});

test('validityGate fails closed on an UNRESOLVED edge (never dropped)', () => {
  const g = validityGate([{ id: 'gh:a/b#1', title: 'a', edges: [{ to: 'gh:a/b#999' }] }]);
  assert.ok(!g.ok);
  assert.ok(g.errors.some((e) => e.includes('unresolved')));
});

test('validityGate catches duplicate ids and cycles', () => {
  assert.ok(!validityGate([{ id: 'T1', title: 'a' }, { id: 'T1', title: 'b' }]).ok);
  const cyc = validityGate([
    { id: 'T1', title: 'a', edges: [{ to: 'T2' }] },
    { id: 'T2', title: 'b', edges: [{ to: 'T1' }] },
  ]);
  assert.ok(!cyc.ok);
  assert.ok(cyc.errors.some((e) => e.includes('cycle')));
});

// ---- pull (end-to-end, offline via a fake provider) ----

function repo({ tickets, sidecar } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-pull-'));
  mkdirSync(join(dir, '.adlc'));
  writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify({ ticketSync: { provider: 'github', repo: 'acme/app' } }));
  if (tickets) writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
  if (sidecar) writeFileSync(join(dir, '.adlc', 'ticket-sync.state.json'), JSON.stringify(sidecar));
  return dir;
}
const fakeProvider = (issues) => ({ listIssues: async () => ({ ok: true, issues }) });
const issue = (number, block, prose = 'desc') => ({
  number, nodeId: `N${number}`, url: `https://github.com/acme/app/issues/${number}`,
  title: `issue ${number}`, body: serializeBlock({ prefix: `${prose}\n`, suffix: '' }, block), labels: [], state: 'open',
});
const readTickets = (dir) => JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8')).tickets;

test('pull is dry-run by default: no write, plan reported', async () => {
  const dir = repo();
  try {
    const r = await pull({ dir, provider: fakeProvider([issue(1, { scope: ['a/**'], duration: 1 })]) });
    assert.equal(r.exitCode, 0);
    assert.ok(r.dryRun);
    assert.ok(r.plan.some((p) => p.id === 'gh:acme/app#1' && p.action === 'create-local'));
    assert.ok(!existsSync(join(dir, '.adlc', 'tickets.json')), 'dry-run must not write');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pull --write materializes the ticket + sidecar (nodeId, syncedHash)', async () => {
  const dir = repo();
  try {
    const r = await pull({ dir, provider: fakeProvider([issue(1, { scope: ['a/**'], duration: 1 })]), write: true, now: 'T' });
    assert.equal(r.exitCode, 0);
    const t = readTickets(dir).find((x) => x.id === 'gh:acme/app#1');
    assert.deepEqual(t.scope, ['a/**']);
    const sc = JSON.parse(readFileSync(join(dir, '.adlc', 'ticket-sync.state.json'), 'utf8'));
    assert.equal(sc.tickets['gh:acme/app#1'].nodeId, 'N1');
    assert.ok(sc.tickets['gh:acme/app#1'].syncedHash);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pull fails closed (exit 2) on a present-but-invalid block', async () => {
  const dir = repo();
  try {
    const bad = { number: 1, nodeId: 'N1', url: '', title: 't', labels: [], state: 'open',
      body: '<!-- adlc:begin v=1 -->\n```json\n{"rails":"oops"}\n```\n<!-- adlc:end -->' };
    const r = await pull({ dir, provider: fakeProvider([bad]), write: true });
    assert.equal(r.exitCode, 2);
    assert.ok(r.errors.some((e) => e.includes('invalid block')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pull fails closed on an unresolved edge to a not-pulled ticket', async () => {
  const dir = repo();
  try {
    const r = await pull({ dir, provider: fakeProvider([issue(1, { edges: [{ to: 'gh:acme/app#777' }], duration: 1 })]), write: true });
    assert.equal(r.exitCode, 2);
    assert.ok(r.errors.some((e) => e.includes('unresolved')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pull: both-changed conflict needs --force; --force adopts remote', async () => {
  // Vary `duration` (not scope/rails) so we isolate CONFLICT resolution from the
  // separate rail/scope guard (which --force does NOT override — by design).
  const baseBlock = { duration: 1 };
  const localBlock = { duration: 2 };
  const remoteBlock = { duration: 3 };
  const mk = () => repo({
    tickets: [{ id: 'gh:acme/app#1', title: 'x', ...localBlock }],
    sidecar: { version: 1, tickets: { 'gh:acme/app#1': { nodeId: 'N1', syncedHash: canonicalHash(baseBlock, { omit: ['$schema'] }) } }, pendingCreates: {} },
  });
  const dir1 = mk();
  try {
    const r = await pull({ dir: dir1, provider: fakeProvider([issue(1, remoteBlock)]), write: true });
    assert.equal(r.exitCode, 2, 'conflict must block without --force');
  } finally { rmSync(dir1, { recursive: true, force: true }); }
  const dir2 = mk();
  try {
    const r = await pull({ dir: dir2, provider: fakeProvider([issue(1, remoteBlock)]), write: true, force: true, now: 'T' });
    assert.equal(r.exitCode, 0);
    assert.equal(readTickets(dir2).find((x) => x.id === 'gh:acme/app#1').duration, 3);
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});

test('pull: --force overrides a CONFLICT but a scope-widen still needs --allow-rail-narrowing', async () => {
  const dir = repo({
    tickets: [{ id: 'gh:acme/app#1', title: 'x', scope: ['local/**'] }],
    sidecar: { version: 1, tickets: { 'gh:acme/app#1': { nodeId: 'N1', syncedHash: canonicalHash({ scope: ['base/**'] }, { omit: ['$schema'] }) } }, pendingCreates: {} },
  });
  try {
    const r = await pull({ dir, provider: fakeProvider([issue(1, { scope: ['remote/**'] })]), write: true, force: true });
    assert.equal(r.exitCode, 2, '--force does not override the rail/scope guard');
    assert.ok(r.errors.some((e) => e.includes('allow-rail-narrowing')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pull unions: a local-only ticket survives the pull', async () => {
  const dir = repo({ tickets: [{ id: 'T1', title: 'local only', scope: ['x/**'] }] });
  try {
    const r = await pull({ dir, provider: fakeProvider([issue(1, { scope: ['a/**'], duration: 1 })]), write: true, now: 'T' });
    assert.equal(r.exitCode, 0);
    const ids = readTickets(dir).map((t) => t.id);
    assert.ok(ids.includes('T1'), 'local-only ticket must survive');
    assert.ok(ids.includes('gh:acme/app#1'), 'pulled ticket must be added');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
