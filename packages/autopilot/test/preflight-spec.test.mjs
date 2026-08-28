// AC 80 / 83 / 89 / 154 — the §14 spec-approval binding for the build ticket:
// newest record wins, content sha256 (never the blob OID), the runner's REAL
// `adlc run p1` gate, the GitHub merge identity, and the §11.1 assumptions —
// including the test that THIS repository's committed approval satisfies its
// own binding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { phaseA, resolveBaseline, phaseB, checkSpecApproval, extractResiduals, assumptionsHash, newestSpecApproval, readManifestAtBaseline, BUILD_TICKET_ID, SPEC_PATH } from '../lib/preflight.mjs';
import { createGitRunner } from '../lib/git-runner.mjs';
import { createSpawner } from '../lib/spawn.mjs';
import { sha256 } from '../lib/git-env.mjs';
import { fakeSpawnImpl } from './helpers/fake-children.mjs';
import { makeFixture, buildCtx, approvalRecord, realExec, git, codeOf, PINNED, REAL, TEST_SPEC_PATH, BUILD_TICKET } from './helpers/preflight-ctx.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUNNER_BIN = join(REPO, 'packages', 'runner', 'bin', 'adlc.mjs');
const build = { ticketId: BUILD_TICKET_ID };
async function full(ctx, opts = build) { await phaseA(ctx); await resolveBaseline(ctx); return phaseB(ctx, opts); }
const dispatches = (ctx) => ctx.recorder.filter((r) => r.argv[0] === PINNED.adlc && r.argv[1] === 'fleet').length;
const lint = (hash) => ({ seq: 1, gate: 'spec-lint', ts: '2026-08-27T17:00:00.000Z', ticket: BUILD_TICKET, files: { [TEST_SPEC_PATH]: hash }, data: { verified: true } });
const premortem = (hash) => ({ seq: 2, gate: 'premortem', ts: '2026-08-27T17:10:00.000Z', ticket: BUILD_TICKET, files: { [TEST_SPEC_PATH]: hash }, data: {} });

export async function ac80_newestApprovalHashPinned() {
  const good = makeFixture();
  try {
    const ctx = buildCtx(good); const r = await full(ctx);
    assert.equal(r.checks.specApproval.specHash, good.specHash, 'equal hash → passes');
    const notBuild = buildCtx(good); const r2 = await full(notBuild, { ticketId: 'T-01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    assert.equal(r2.checks.specApproval, 'skipped: not-build-ticket', 'the binding applies to the build ticket only');
  } finally { good.cleanup(); }
  // An older MATCHING record followed by a newer non-matching one → stale (newest wins).
  const stale = makeFixture({ manifest: null });
  const items = stale.items;
  const older = approvalRecord({ specHash: stale.specHash, items, seq: 3, ts: '2026-08-27T17:58:38.616Z' });
  const newer = approvalRecord({ specHash: 'f'.repeat(64), items, seq: 4, ts: '2026-08-27T18:30:00.000Z' });
  stale.cleanup();
  const fx = makeFixture({ manifest: [lint(older.data.spec_hash), premortem(older.data.spec_hash), older, newer] });
  try {
    const ctx = buildCtx(fx);
    assert.equal(await codeOf(() => full(ctx)), 'spec-approval-stale');
    assert.equal(dispatches(ctx), 0, 'zero dispatches');
    const entries = [older, newer].map((e) => ({ ...e, segment: 's' }));
    assert.equal(newestSpecApproval(entries, BUILD_TICKET).seq, 4, 'newest by ts');
    assert.equal(newestSpecApproval([{ ...newer, ts: undefined, __order: 0 }, { ...older, ts: undefined, __order: 1 }], BUILD_TICKET).seq, 3, 'without ts: segment order, then seq');
    assert.equal(newestSpecApproval(entries, 'T-01ARZ3NDEKTSV4RRFFQ69G5FAV'), null);
  } finally { fx.cleanup(); }
  const differs = makeFixture({ manifest: [lint('a'.repeat(64)), premortem('a'.repeat(64)), approvalRecord({ specHash: 'a'.repeat(64), items: ['x'] })] });
  try { const ctx = buildCtx(differs); assert.equal(await codeOf(() => full(ctx)), 'spec-approval-stale'); assert.equal(dispatches(ctx), 0); } finally { differs.cleanup(); }
}
test('AC80: the newest spec-approval records spec_hash must equal the sha256 of the spec blob at BASE_OID — a differing hash → spec-approval-stale with zero dispatches; equal → passes; an older matching record followed by a newer non-matching one → stale', ac80_newestApprovalHashPinned);

const realRunner = (args, o) => (args[0] === 'run' ? realExec(process.execPath)([RUNNER_BIN, ...args], o) : undefined);

export async function ac83_realRunnerGate() {
  const ok = makeFixture({ manifestLayout: 'root' });
  try {
    const ctx = buildCtx(ok, { adlc: { override: realRunner } });
    const r = await full(ctx);
    assert.equal(r.checks.specApproval.runnerGate, 'ok', 'the REAL adlc run p1 exits 0 against the pinned checkout');
    const p1 = ctx.recorder.find((x) => x.argv[0] === PINNED.adlc && x.argv[1] === 'run');
    assert.deepEqual(p1.argv.slice(1, 6), ['run', 'p1', '--ticket', BUILD_TICKET, '--json']);
    assert.equal(p1.cwd, ok.paths.preflightWorktree(ok.baseOid), 'runs in the detached preflight worktree, never the primary checkout');
    assert.equal(p1.argv[7], join(p1.cwd, '.adlc')); assert.equal(p1.env.ADLC_MANIFEST_KEY, undefined, 'the runner gate is not key-bearing');
    assert.equal(dispatches(ctx), 1, 'dispatch allowed');
  } finally { ok.cleanup(); }
  const red = (name, manifestFor) => async () => {
    const fx = makeFixture({ manifestLayout: 'root', manifest: null });
    const m = manifestFor(fx.specHash, fx.items); fx.cleanup();
    const f = makeFixture({ manifestLayout: 'root', manifest: m });
    try { const ctx = buildCtx(f, { adlc: { override: realRunner } }); assert.equal(await codeOf(() => full(ctx)), 'spec-approval-stale', name); assert.equal(dispatches(ctx), 0, `${name}: zero dispatches`); }
    finally { f.cleanup(); }
  };
  await red('missing premortem', (h, items) => [lint(h), approvalRecord({ specHash: h, items })])();
  await red('unresolved: 1', (h, items) => [lint(h), premortem(h), approvalRecord({ specHash: h, items, overrides: { unresolved: 1 } })])();
  await red('rounds: 0', (h, items) => [lint(h), premortem(h), approvalRecord({ specHash: h, items, overrides: { rounds: 0 } })])();
  // The committed record of THIS repository satisfies the content-hash clause.
  const spec = spawnSync(REAL.git, ['show', `HEAD:${SPEC_PATH}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(spec.status, 0);
  const rec = await committedApproval();
  assert.equal(rec.data.spec_hash, sha256(spec.stdout), `the newest committed spec-approval (seq ${rec.seq}, ${rec.segment}) equals sha256sum of the committed spec`);
}
test('AC83: the REAL adlc run p1 binary against a temporary manifest — lint + premortem + a full-contract approval → exit 0 and dispatch; missing premortem, unresolved:1 or rounds:0 → spec-approval-stale with zero dispatches; the committed record equals sha256sum of the committed spec', ac83_realRunnerGate);

export async function ac83_contentHashNeverBlobOid() {
  const probe = makeFixture({ manifestLayout: 'root' });
  const blobOid = git(probe.repoRoot, ['rev-parse', `HEAD:${TEST_SPEC_PATH}`]);
  const items = probe.items; probe.cleanup();
  const fx = makeFixture({ manifestLayout: 'root', manifest: [lint(blobOid), premortem(blobOid), approvalRecord({ specHash: blobOid, items })] });
  try {
    assert.equal(git(fx.repoRoot, ['rev-parse', `HEAD:${TEST_SPEC_PATH}`]), blobOid, 'same content, same blob OID');
    const ctx = buildCtx(fx, { adlc: { override: realRunner } });
    assert.equal(await codeOf(() => full(ctx)), 'spec-approval-stale', 'a record carrying the git blob OID instead of the content sha256 is stale');
    assert.equal(dispatches(ctx), 0);
    assert.equal(await codeOf(() => checkSpecApproval({ ctx, oid: fx.baseOid, ticketId: BUILD_TICKET_ID, runnerCwd: null })), 'spec-approval-stale', 'the module-level comparison itself never conflates the identities (independent of the runner gate)');
    assert.notEqual(blobOid.length, fx.specHash.length, 'the identities have different lengths and are never compared to each other');
  } finally { fx.cleanup(); }
}
test('AC83: a spec-approval whose spec_hash is the git blob OID of the same file (rev-parse HEAD:<path>) instead of the content sha256 is spec-approval-stale', ac83_contentHashNeverBlobOid);

export async function ac89_mergeIdentity() {
  const fx = makeFixture();
  try {
    const merged = (login, extra = {}) => [{ number: 7, merged_at: '2026-08-27T18:00:00Z', merged_by: { login }, ...extra }];
    const run = async (gh) => { const ctx = buildCtx(fx, { gh }); await phaseA(ctx); await resolveBaseline(ctx); const c = await codeOf(() => phaseB(ctx, build)); return { c, ctx }; };
    let r = await run({ pulls: merged('octo'), permission: 'maintain' });
    assert.equal(r.c, null, 'merged by a maintain login equal to the approver → dispatch allowed'); assert.equal(dispatches(r.ctx), 1);
    const cases = [
      ['merged by a write login', { pulls: merged('octo'), permission: 'write' }],
      ['an unmerged PR', { pulls: [{ number: 7, merged_at: null, merged_by: null }] }],
      ['no PR', { pulls: [] }],
      ['the approver names a different login', { pulls: merged('someone-else') }],
    ];
    for (const [name, gh] of cases) { r = await run(gh); assert.equal(r.c, 'spec-approval-unbound', name); assert.equal(dispatches(r.ctx), 0, `${name}: zero dispatches`); }
    const argv = r.ctx.recorder.find((x) => x.argv[0] === PINNED.gh && /commits\/[0-9a-f]{40}\/pulls/.test(x.argv[2])).argv;
    assert.equal(argv[2], `repos/o/r/commits/${fx.baseOid}/pulls`, 'the commit that introduced the spec blob is resolved to its PR');
  } finally { fx.cleanup(); }
  const byEmail = makeFixture({ manifest: null });
  const items = byEmail.items; const h = byEmail.specHash; byEmail.cleanup();
  const fx2 = makeFixture({ manifest: [lint(h), premortem(h), approvalRecord({ specHash: h, items, approver: 'octo@example.com' })] });
  try { const ctx = buildCtx(fx2); assert.equal(await codeOf(() => full(ctx)), null, 'the e-mail GitHub reports for the merging login is accepted as the approver'); } finally { fx2.cleanup(); }
}
test('AC89: the spec commits PR merged by an admin/maintain login named by the records approver (login or GitHub e-mail) → dispatch; merged by write, unmerged, no PR, or another login → spec-approval-unbound with zero dispatches', ac89_mergeIdentity);

/** The newest committed spec-approval of the build ticket, read from THIS repository at HEAD through the production reader. */
async function committedApproval() {
  const recorder = [];
  const { spawnImpl } = fakeSpawnImpl({ [PINNED.git]: realExec(REAL.git) });
  const ctx = { repoRoot: REPO, spawn: createSpawner({ recorder, spawnImpl }), pinned: PINNED, env: { path: process.env.PATH, home: REPO, base: { PATH: process.env.PATH, HOME: REPO } }, inherited: {} };
  ctx.git = createGitRunner(ctx);
  const head = git(REPO, ['rev-parse', 'HEAD']);
  const entries = await readManifestAtBaseline(ctx, head);
  const rec = newestSpecApproval(entries, BUILD_TICKET_ID);
  assert.ok(rec, 'this repository carries a spec-approval for the build ticket');
  return rec;
}

export async function ac154_assumptionsBound() {
  // The extractor is a pure function with a fixture for the CURRENT §11.1 of this repository's committed spec.
  const spec = spawnSync(REAL.git, ['show', `HEAD:${SPEC_PATH}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
  const items = extractResiduals(spec);
  assert.equal(items.length, 8, 'the current §11.1 has eight items');
  assert.ok(items[0].startsWith('The model API host is the one permitted model-plane egress destination;'), 'line breaks collapse to one space');
  assert.ok(items[7].endsWith('a pull request opened after the last re-check is the residual.'));
  assert.ok(items.every((s) => !/\s\s/.test(s)), 'no double whitespace survives');
  assert.deepEqual(extractResiduals('no such heading'), []);
  assert.deepEqual(extractResiduals('### 11.1 X\n\n1. a\n   b\n\n2. c\n## 12\n1. not'), ['a b', 'c'], 'items stop at the next heading; a blank line ends an item');
  assert.equal(assumptionsHash(items), sha256(JSON.stringify(items)));
  // The committed approval must satisfy its own binding (the real preflight comparison).
  const rec = await committedApproval();
  assert.equal(rec.data.assumptions_hash, assumptionsHash(items), `assumptions_hash of the newest committed record (seq ${rec.seq}) equals the extractor hash`);
  assert.deepEqual(rec.data.approved_assumptions, items, 'approved_assumptions equal the §11.1 items element for element');
  // Fixtures: a differing hash or a differing list → spec-approval-assumptions-stale with zero dispatches; matching → passes.
  const probe = makeFixture(); const h = probe.specHash; const fixtureItems = probe.items; probe.cleanup();
  for (const [name, overrides] of [['assumptions_hash differs', { assumptions_hash: 'e'.repeat(64) }], ['approved_assumptions differ', { approved_assumptions: [...fixtureItems.slice(0, -1), 'an earlier design\'s residual'] }], ['hash absent', { assumptions_hash: undefined }]]) {
    const fx = makeFixture({ manifest: [lint(h), premortem(h), approvalRecord({ specHash: h, items: fixtureItems, overrides })] });
    try { const ctx = buildCtx(fx); assert.equal(await codeOf(() => full(ctx)), 'spec-approval-assumptions-stale', name); assert.equal(dispatches(ctx), 0, `${name}: zero dispatches`); }
    finally { fx.cleanup(); }
  }
  const good = makeFixture();
  try { const ctx = buildCtx(good); const r = await full(ctx); assert.equal(r.checks.specApproval.assumptionsHash, assumptionsHash(good.items)); assert.equal(dispatches(ctx), 1); } finally { good.cleanup(); }
}
test('AC154: the §11.1 extractor is pure (fixture for the current section); a record whose assumptions_hash or approved_assumptions differ → spec-approval-assumptions-stale with zero dispatches; a matching one passes; THIS repositorys committed spec and newest spec-approval satisfy the real comparison', ac154_assumptionsBound);
