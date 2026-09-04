// Selection + authorization (spec §4, §2 `--issue`/`--force`; AC 3 19 33 79
// 85 97 109 155 — the module halves; the `once`-level exits and the
// shaping/fleet-fake never-invoked assertions live in sequence.test).
//
// Rule naming (see lib/authorize.mjs header): `dispatch-approval` is emitted
// ONLY for a trusted-class author excluded solely because the mode's approval
// label was never applied; every other failure is `not-authorized`.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreIssue, hardExclusions, selectIssue, FORCE_LIFTABLE_RULES, QUARANTINE_STATES } from '../lib/select.mjs';
import { eligibleAuthor, revisionOf, sameRevision } from '../lib/authorize.mjs';
import { buildDenylist } from '../lib/denylist.mjs';
import { LABELS, STOP_LABELS, EXCLUDING_LABELS } from '../lib/labels.mjs';
import { createRecordStore } from '../lib/records.mjs';
import { autopilotPaths } from '../lib/paths.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { branchFor } from '../lib/input.mjs';
import * as F from './helpers/select-fixtures.mjs';

const AUTH_OK = Object.freeze({ ok: true, rule: null, clause: 'author' });
const denylist = buildDenylist(F.denylistSources());
const N = 4;
const clean = (over = {}) => ({ issue: F.makeIssue({ number: N }), authorization: AUTH_OK, openPrs: [], localBranches: [], remoteRefExists: false, records: null, scopeBlock: null, denylist, attempts: 0, ...over });
const rules = (r) => r.map((x) => x.rule);

/** Every §4.2 rule with a fixture that triggers it: [rule, hardExclusions overrides]. */
function exclusionTable() {
  const rows = [
    ['not-authorized', { authorization: { ok: false, rule: 'not-authorized' } }],
    ['dispatch-approval', { authorization: { ok: false, rule: 'dispatch-approval' } }],
    ...EXCLUDING_LABELS.map((l) => [`label:${l}`, { issue: F.makeIssue({ number: N, labels: [l] }) }]),
    ['programs-milestone', { issue: F.makeIssue({ number: N, milestone: 'Programs: autopilot' }) }],
    ['open-pr', { openPrs: [{ number: 9, headRefName: branchFor(N), body: '' }] }],
    ['open-pr', { openPrs: [{ number: 9, headRefName: 'feat/x', body: `Some text\n\nCloses #${N}` }] }],
    ['open-pr', { openPrs: [{ number: 9, headRefName: 'feat/x', body: `Fixes #${N} and more` }] }],
    ['local-branch', { localBranches: ['main', branchFor(N)] }],
    ['protected-path', { scopeBlock: ['scripts/preflight.mjs'] }],
    ['protected-path', { scopeBlock: ['packages/autopilot/**', 'packages/core/lib/**'] }],
    ['remote-ref-exists', { remoteRefExists: true }],
    ['remote-ref-pending', { records: { issue: N, state: 'remote-pending' } }],
    ['orphan', { records: { issue: N, state: 'orphan' } }],
    ['shaping-failed', { attempts: 3 }],
    ['shaping-failed', { attempts: { failedWithin24h: 5 } }],
    ...QUARANTINE_STATES.map((s) => ['quarantined', { records: { issue: N, state: s } }]),
  ];
  return rows;
}

export async function ac3_selection() {
  // (1) every §4.2 rule has a fixture excluded under that rule name
  for (const [rule, over] of exclusionTable()) {
    const got = rules(hardExclusions(clean(over)));
    assert.ok(got.includes(rule), `${rule}: got ${JSON.stringify(got)}`);
  }
  assert.deepEqual(hardExclusions(clean()), [], 'a clean fixture has no exclusion');
  assert.deepEqual(hardExclusions(clean({ openPrs: [{ number: 9, headRefName: 'feat/x', body: `Closes #${N}1` }] })), [], 'Closes #41 does not close #4');
  assert.deepEqual(hardExclusions(clean({ records: { issue: N, state: 'pr-open' } })), [], 'an active record is not a quarantine');
  assert.deepEqual(hardExclusions(clean({ attempts: 2 })), [], 'two failed attempts do not exclude');
  assert.deepEqual(hardExclusions(clean({ scopeBlock: ['packages/autopilot/**', 'docs/guides/**'] })), [], 'a scope outside the denylist is clean');
  // (2) the scoring table on the 12-issue fixture, and adlc:autopilot outranks P0-critical
  const r = await selectIssue({ candidates: F.scoringFixture(), evaluate: () => [], now: () => F.NOW });
  assert.deepEqual(r.ranked.map((x) => x.number), [...F.SCORING_ORDER], 'documented order (ties → lower number)');
  for (const x of r.ranked) assert.equal(x.score, F.SCORING_SCORES[x.number], `#${x.number} score`);
  assert.equal(r.picked.number, 12);
  const auto = scoreIssue(F.makeIssue({ labels: [LABELS.autopilot] }), F.NOW);
  const p0 = scoreIssue(F.makeIssue({ labels: ['P0-critical', 'bug', 'security', 'area:x'], createdAt: F.daysAgo(3000) }), F.NOW);
  assert.ok(auto.score > p0.score, `adlc:autopilot (${auto.score}) outranks a maxed P0-critical (${p0.score})`);
  assert.equal(p0.breakdown.age, 20, 'age is capped at +20');
  assert.equal(auto.breakdown.autopilot, 1000);
  assert.equal(scoreIssue(F.makeIssue({ labels: ['area:a', 'area:b'] }), F.NOW).breakdown.area, 0, 'two area labels → no single-area bonus');
  // (3) the denylist cannot be shrunk by config: a config that omits `.adlc/**` still excludes it
  const shrunk = buildDenylist({ ...F.denylistSources(), extras: ['docs/x/**'] });
  assert.ok(shrunk.globs.includes('.adlc/**'), 'config omitting .adlc/** does not remove it');
  assert.equal(shrunk.matches('.adlc/config.json'), true);
  assert.equal(shrunk.matches('docs/x/y.md'), true, 'extras extend');
  assert.deepEqual(rules(hardExclusions(clean({ scopeBlock: ['.adlc/tickets/**'], denylist: shrunk }))), ['protected-path']);
}
test('AC3: every §4.2 rule has an excluded fixture naming it; the 12-issue fixture ranks in the documented order; adlc:autopilot outranks P0-critical; the denylist cannot be shrunk by config', ac3_selection);

export async function ac19_pinnedIssueHonorsExclusions() {
  // every rule: a pinned excluded issue is refused naming the rule
  for (const [rule, over] of exclusionTable()) {
    const args = clean(over);
    const r = await selectIssue({ candidates: [args.issue], evaluate: (i) => hardExclusions({ ...args, issue: i }), pinned: N, now: () => F.NOW });
    assert.equal(r.picked, null, `${rule}: pinned issue not picked`);
    assert.equal(r.reason, 'excluded');
    assert.ok(r.rules.includes(rule), `${rule}: named in rules ${JSON.stringify(r.rules)}`);
  }
  // --force lifts exactly the five STOP labels (table-driven over the FULL excluding list)
  assert.deepEqual([...FORCE_LIFTABLE_RULES], STOP_LABELS.map((l) => `label:${l}`));
  assert.equal(STOP_LABELS.length, 5);
  for (const label of EXCLUDING_LABELS) {
    const issue = F.makeIssue({ number: N, labels: [label] });
    const r = await selectIssue({ candidates: [issue], evaluate: (i) => hardExclusions(clean({ issue: i })), pinned: N, force: true, now: () => F.NOW });
    const lifts = STOP_LABELS.includes(label);
    assert.equal(r.picked !== null, lifts, `--force ${lifts ? 'lifts' : 'does not lift'} ${label}`);
    if (lifts) assert.deepEqual(r.ranked[0].lifted.map((x) => x.rule), [`label:${label}`]);
    else assert.deepEqual(r.rules, [`label:${label}`]);
  }
  // never the protected-path, milestone, open-PR, local-branch, remote-ref or authorization rules
  const never = exclusionTable().filter(([rule]) => !rule.startsWith('label:'));
  for (const [rule, over] of never) {
    const args = clean(over);
    const r = await selectIssue({ candidates: [args.issue], evaluate: (i) => hardExclusions({ ...args, issue: i }), pinned: N, force: true, now: () => F.NOW });
    assert.equal(r.picked, null, `--force never lifts ${rule}`);
    assert.ok(r.rules.includes(rule));
  }
  // a STOP label together with a non-liftable rule stays excluded, naming only the survivor
  const both = F.makeIssue({ number: N, labels: [LABELS.blocked], milestone: 'Programs: x' });
  const r = await selectIssue({ candidates: [both], evaluate: (i) => hardExclusions(clean({ issue: i })), pinned: N, force: true, now: () => F.NOW });
  assert.equal(r.picked, null); assert.deepEqual(r.rules, ['programs-milestone']);
  await assert.rejects(selectIssue({ candidates: [both], evaluate: () => [], force: true }), { code: 'bad-input:force' }, '--force requires --issue');
  const missing = await selectIssue({ candidates: [both], evaluate: () => [], pinned: 99 });
  assert.equal(missing.reason, 'issue-not-found');
}
test('AC19: a pinned excluded issue is refused naming every rule; --force lifts only the five STOP labels (table-driven over the full excluding list) and never protected-path, trust-root-change, milestone, open-PR or the other rules', ac19_pinnedIssueHonorsExclusions);

const MODES = ['owner-or-label', 'label-only', 'trusted-authors'];
const ASSOCS = ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'];
const ACTORS = { none: null, admin: 'admin', maintain: 'maint', write: 'writer', triage: 'triager' };
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const authorClause = (mode, assoc) => (mode === 'owner-or-label' ? assoc === 'OWNER' : mode === 'label-only' ? false : TRUSTED.includes(assoc));

/** issue + timeline for "author of class `assoc`, label applied by `actor` (or none)". */
function authored(assoc, actorKey, { number = 7 } = {}) {
  const actor = ACTORS[actorKey];
  const issue = F.makeIssue({ number, author: 'alice', association: assoc, labels: actor ? [LABELS.autopilot] : [] });
  const timeline = actor ? [F.labeled(actor, F.at(10))] : [];
  return { issue, timeline, edits: F.edits(), permissionOf: F.perms() };
}

export async function ac33_oneAuthorizationPredicate() {
  let rows = 0;
  for (const mode of MODES) for (const assoc of ASSOCS) for (const actorKey of Object.keys(ACTORS)) {
    const r = await eligibleAuthor({ ...authored(assoc, actorKey), mode });
    const viaLabel = actorKey === 'admin' || actorKey === 'maintain';
    const expectOk = authorClause(mode, assoc) || viaLabel;
    const tag = `${mode} × ${assoc} × label-by:${actorKey}`;
    assert.equal(r.ok, expectOk, tag);
    if (expectOk) assert.equal(r.clause, authorClause(mode, assoc) ? 'author' : 'label', tag);
    else assert.equal(r.rule, actorKey === 'none' && TRUSTED.includes(assoc) ? 'dispatch-approval' : 'not-authorized', tag);
    rows++;
  }
  assert.equal(rows, MODES.length * ASSOCS.length * Object.keys(ACTORS).length);
  // the spec's spot checks, verbatim
  assert.equal((await eligibleAuthor({ ...authored('OWNER', 'none'), mode: 'owner-or-label' })).ok, true, 'default: OWNER needs no label');
  assert.equal((await eligibleAuthor({ ...authored('MEMBER', 'none'), mode: 'owner-or-label' })).ok, false, 'default: MEMBER excluded unlabeled');
  assert.equal((await eligibleAuthor({ ...authored('COLLABORATOR', 'write'), mode: 'owner-or-label' })).rule, 'not-authorized', 'a write-actor label never authorizes');
  assert.equal((await eligibleAuthor({ ...authored('OWNER', 'none'), mode: 'label-only' })).ok, false, 'label-only: even OWNER needs the label');
  assert.equal((await eligibleAuthor({ ...authored('COLLABORATOR', 'none'), mode: 'trusted-authors' })).ok, true, 'trusted-authors: COLLABORATOR eligible unlabeled');
  await assert.rejects(eligibleAuthor({ ...authored('OWNER', 'admin'), mode: 'everyone' }), { code: 'bad-config' });
}
test('AC33: one predicate, table-driven over mode × authorAssociation × label-actor permission — OWNER eligible unlabeled by default, MEMBER/COLLABORATOR only after an admin/maintain label, a write-actor label never authorizes, label-only needs the label even for OWNER, trusted-authors admits MEMBER/COLLABORATOR', ac33_oneAuthorizationPredicate);

export async function ac79_dispatchApprovalModes() {
  const unlabeled = await eligibleAuthor({ ...authored('COLLABORATOR', 'none'), mode: 'label-only' });
  assert.deepEqual([unlabeled.ok, unlabeled.rule], [false, 'dispatch-approval'], 'label-only: COLLABORATOR without the label → dispatch-approval');
  const byAdmin = await eligibleAuthor({ ...authored('COLLABORATOR', 'admin'), mode: 'label-only' });
  assert.deepEqual([byAdmin.ok, byAdmin.clause], [true, 'label']);
  const byWrite = await eligibleAuthor({ ...authored('COLLABORATOR', 'write'), mode: 'label-only' });
  assert.deepEqual([byWrite.ok, byWrite.rule], [false, 'not-authorized']);
  assert.equal((await eligibleAuthor({ ...authored('OWNER', 'none'), mode: 'owner-or-label' })).ok, true, 'default: the §4.2 trust predicate');
  assert.equal((await eligibleAuthor({ ...authored('NONE', 'none'), mode: 'owner-or-label' })).rule, 'not-authorized');
  for (const bad of ['anything-goes', 'OWNER-OR-LABEL', '', 42, {}]) {
    await assert.rejects(eligibleAuthor({ ...authored('OWNER', 'admin'), mode: bad }), (e) => e.code === 'bad-config' && e.exitCode === 1, `mode ${JSON.stringify(bad)} → bad-config`);
  }
}
test('AC79: label-only excludes an unlabeled COLLABORATOR issue (dispatch-approval), admits it labeled by an admin, refuses a write-actor label; the default applies the §4.2 predicate; an unknown mode → bad-config', ac79_dispatchApprovalModes);

export async function ac85_dispatchApprovalDefault() {
  const owner = await eligibleAuthor({ ...authored('OWNER', 'none'), mode: undefined });
  assert.deepEqual([owner.ok, owner.clause], [true, 'author'], 'default mode: OWNER eligible without a label');
  const collab = await eligibleAuthor({ ...authored('COLLABORATOR', 'none'), mode: 'owner-or-label' });
  assert.deepEqual([collab.ok, collab.rule], [false, 'dispatch-approval']);
  const member = await eligibleAuthor({ ...authored('MEMBER', 'none'), mode: 'owner-or-label' });
  assert.deepEqual([member.ok, member.rule], [false, 'dispatch-approval']);
  const labeledByAdmin = await eligibleAuthor({ ...authored('COLLABORATOR', 'admin'), mode: 'owner-or-label' });
  assert.deepEqual([labeledByAdmin.ok, labeledByAdmin.clause], [true, 'label']);
  const trusted = await eligibleAuthor({ ...authored('COLLABORATOR', 'none'), mode: 'trusted-authors' });
  assert.deepEqual([trusted.ok, trusted.clause], [true, 'author'], 'trusted-authors admits it');
  const labelOnlyOwner = await eligibleAuthor({ ...authored('OWNER', 'none'), mode: 'label-only' });
  assert.deepEqual([labelOnlyOwner.ok, labelOnlyOwner.rule], [false, 'dispatch-approval'], 'label-only still holds');
  await assert.rejects(eligibleAuthor({ ...authored('OWNER', 'none'), mode: 'unknown-value' }), { code: 'bad-config' });
}
test('AC85: by default an OWNER issue is eligible unlabeled and a COLLABORATOR issue is dispatch-approval until an admin labels it; trusted-authors admits it; the label-only and unknown-value cases still hold', ac85_dispatchApprovalDefault);

export async function ac97_selectionTimeRemoteCheck() {
  const branch = branchFor(N);
  // no record, no tombstone: a remote ref alone excludes
  assert.deepEqual(hardExclusions(clean({ remoteRefExists: true })), [{ rule: 'remote-ref-exists', detail: branch }]);
  // tombstone present (record deleted by the canonical rule) — the remote check is independent of it
  const root = mkdtempSync(join(tmpdir(), 'ap-select-'));
  try {
    const paths = autopilotPaths(root);
    const store = createRecordStore({ paths, redactor: createRedactor() });
    store.save({ issue: N, state: 'done', lastPushedOid: 'a'.repeat(40), branch });
    store.remove(N);
    assert.equal(existsSync(paths.record(N)), false, 'record deleted');
    const tomb = store.tombstone(N);
    assert.equal(tomb.lastPushedOid, 'a'.repeat(40), 'the tombstone carries lastPushedOid');
    assert.ok(tomb.deletedAt);
    assert.deepEqual(rules(hardExclusions(clean({ remoteRefExists: true, records: store }))), ['remote-ref-exists'], 'excluded with a tombstone and no record');
    assert.deepEqual(hardExclusions(clean({ remoteRefExists: false, records: store })), [], 'no remote ref + tombstone → eligible again');
  } finally { rmSync(root, { recursive: true, force: true }); }
  // an unanswered ls-remote fails closed
  assert.deepEqual(rules(hardExclusions(clean({ remoteRefExists: undefined }))), ['remote-ref-unverified']);
  assert.deepEqual(rules(hardExclusions(clean({ remoteRefExists: 'yes' }))), ['remote-ref-unverified']);
  // the record-state twin: a remote-pending record → remote-ref-pending (a different rule)
  assert.deepEqual(rules(hardExclusions(clean({ records: { issue: N, state: 'remote-pending' } }))), ['remote-ref-pending']);
}
test('AC97: an issue whose branch name has a remote ref is excluded with remote-ref-exists with no record and no tombstone, and still with a tombstone (which carries lastPushedOid); an unanswered check fails closed', ac97_selectionTimeRemoteCheck);

export async function ac109_labelRemovalRevokes() {
  const run = (labelsPresent, timeline, mode = 'owner-or-label') => eligibleAuthor({
    issue: F.makeIssue({ number: 8, author: 'zed', association: 'NONE', labels: labelsPresent ? [LABELS.autopilot] : [] }),
    timeline, edits: F.edits(), permissionOf: F.perms(), mode,
  });
  const a = await run(false, [F.labeled('admin', F.at(0)), F.unlabeled('outsider', F.at(5))]);
  assert.deepEqual([a.ok, a.rule], [false, 'not-authorized'], 'labeled(admin) → unlabeled(anyone), label absent');
  const b = await run(true, [F.labeled('admin', F.at(0)), F.unlabeled('outsider', F.at(5)), F.labeled('writer', F.at(9))]);
  assert.deepEqual([b.ok, b.rule], [false, 'not-authorized'], 'labeled(admin) → unlabeled → labeled(write)');
  const c = await run(true, [F.labeled('admin', F.at(0)), F.unlabeled('outsider', F.at(5)), F.labeled('maint', F.at(9))]);
  assert.deepEqual([c.ok, c.clause], [true, 'label'], 'labeled(admin) → unlabeled → labeled(maintain), label present');
  const d = await run(true, []);
  assert.deepEqual([d.ok, d.rule], [false, 'not-authorized'], 'label present but NO timeline event');
  const e = await run(true, F.UNREADABLE);
  assert.deepEqual([e.ok, e.rule, e.reason], [false, 'not-authorized', 'timeline-unreadable'], 'label present but the timeline is unreadable');
  const f = await run(true, [F.labeled('admin', F.at(0)), F.unlabeled('outsider', F.at(5))]);
  assert.deepEqual([f.ok, f.rule], [false, 'not-authorized'], 'the LATEST event is an unlabel: revoked even if the label shows as present');
  // ordering is by created_at, ties by id — an admin label with a LATER timestamp but lower id still wins
  const late = { ...F.labeled('admin', F.at(20)), id: 1 };
  const g = await run(true, [F.unlabeled('outsider', F.at(5)), late]);
  assert.equal(g.ok, true, 'created_at order, not array order');
  const tie = await run(true, [{ ...F.labeled('admin', F.at(5)), id: 1 }, { ...F.unlabeled('outsider', F.at(5)), id: 2 }]);
  assert.equal(tie.ok, false, 'equal created_at: the higher id is later');
  // the same fixtures under label-only and trusted-authors
  for (const mode of ['label-only', 'trusted-authors']) {
    assert.equal((await run(true, [F.labeled('admin', F.at(0)), F.unlabeled('outsider', F.at(5)), F.labeled('writer', F.at(9))], mode)).ok, false, mode);
    assert.equal((await run(true, [F.labeled('admin', F.at(0)), F.unlabeled('outsider', F.at(5)), F.labeled('maint', F.at(9))], mode)).ok, true, mode);
  }
}
test('AC109: labeled(admin)→unlabeled with the label absent, →unlabeled→labeled(write), a label with no readable timeline event, or a latest unlabel → not-authorized; →unlabeled→labeled(maintain) with the label present → eligible', ac109_labelRemovalRevokes);

export async function ac155_authorizationBindsRevision() {
  const t0 = F.at(0); const t1 = F.at(10); const t2 = F.at(20); const t3 = F.at(30);
  const issue = (assoc, labelsPresent = false) => F.makeIssue({ number: 9, author: 'alice', association: assoc, labels: labelsPresent ? [LABELS.autopilot] : [] });
  const go = (args) => eligibleAuthor({ permissionOf: F.perms(), ...args });
  // owner-or-label: an OWNER issue touched by a collaborator
  const e1 = await go({ issue: issue('OWNER'), timeline: [], edits: F.edits([F.editBy('collab', t1)]), mode: 'owner-or-label' });
  assert.deepEqual([e1.ok, e1.rule, e1.reason], [false, 'not-authorized', 'revision-not-by-author'], 'OWNER body edited by a collaborator');
  const r1 = await go({ issue: issue('OWNER'), timeline: [F.renamed('collab', t1)], edits: F.edits(), mode: 'owner-or-label' });
  assert.deepEqual([r1.ok, r1.rule], [false, 'not-authorized'], 'OWNER issue renamed by a collaborator');
  // trusted-authors: a MEMBER issue, unlabeled
  const e2 = await go({ issue: issue('MEMBER'), timeline: [], edits: F.edits([F.editBy('collab', t1)]), mode: 'trusted-authors' });
  assert.deepEqual([e2.ok, e2.rule], [false, 'not-authorized'], 'MEMBER body edited by a different COLLABORATOR');
  const r2 = await go({ issue: issue('MEMBER'), timeline: [F.renamed('collab', t1)], edits: F.edits(), mode: 'trusted-authors' });
  assert.deepEqual([r2.ok, r2.rule], [false, 'not-authorized'], 'MEMBER issue renamed by a different COLLABORATOR');
  const self = await go({ issue: issue('MEMBER'), timeline: [F.renamed('alice', t1)], edits: F.edits([F.editBy('alice', t1)]), mode: 'trusted-authors' });
  assert.deepEqual([self.ok, self.clause], [true, 'author'], 'edited and renamed only by its author → eligible');
  // an admin label LATER than lastEditedAt and the rename → eligible in every mode
  for (const mode of MODES) {
    const ok = await go({ issue: issue('MEMBER', true), timeline: [F.renamed('collab', t1), F.labeled('admin', t2)], edits: F.edits([F.editBy('collab', t1)]), mode });
    assert.deepEqual([ok.ok, ok.clause], [true, 'label'], `${mode}: admin label after the edit authorizes the revision`);
    // a body edit AFTER that label event revokes it again
    const again = await go({ issue: issue('MEMBER', true), timeline: [F.labeled('admin', t2)], edits: F.edits([F.editBy('collab', t1), F.editBy('collab', t3)]), mode });
    assert.deepEqual([again.ok, again.rule], [false, 'not-authorized'], `${mode}: edit after the label → not-authorized`);
    // a rename by a non-maintainer AFTER the label revokes; a rename by a maintainer does not
    const renamedAfter = await go({ issue: issue('MEMBER', true), timeline: [F.labeled('admin', t2), F.renamed('collab', t3)], edits: F.edits(), mode });
    assert.equal(renamedAfter.ok, false, `${mode}: rename after the label by a non-maintainer`);
    const renamedByMaint = await go({ issue: issue('MEMBER', true), timeline: [F.labeled('admin', t2), F.renamed('maint', t3)], edits: F.edits(), mode });
    assert.equal(renamedByMaint.ok, true, `${mode}: a maintainer's rename does not revoke`);
    // an unreadable edit history → not-authorized, even for an OWNER
    const unreadable = await go({ issue: issue('OWNER', true), timeline: [F.labeled('admin', t2)], edits: F.UNREADABLE, mode });
    assert.deepEqual([unreadable.ok, unreadable.rule, unreadable.reason], [false, 'not-authorized', 'edits-unreadable'], `${mode}: unreadable edits`);
    // label exactly AT lastEditedAt is not later
    const same = await go({ issue: issue('MEMBER', true), timeline: [F.labeled('admin', t1)], edits: F.edits([F.editBy('collab', t1)]), mode });
    assert.equal(same.ok, false, `${mode}: a label at lastEditedAt is not later than it`);
  }
  // the recorded revision digest is what revalidation compares byte for byte
  const base = issue('OWNER');
  const rev = revisionOf(base, F.edits([F.editBy('alice', t0)]));
  assert.deepEqual(Object.keys(rev).sort(), ['bodySha256', 'editors', 'editsReadable', 'lastEditedAt', 'titleSha256']);
  assert.equal(rev.titleSha256.length, 64);
  assert.equal(sameRevision(rev, revisionOf({ ...base }, F.edits([F.editBy('alice', t0)]))), true);
  assert.equal(sameRevision(rev, revisionOf({ ...base, body: base.body + ' ' }, F.edits([F.editBy('alice', t0)]))), false, 'a body edit changes the revision');
  assert.equal(sameRevision(rev, revisionOf(base, F.edits([F.editBy('alice', t0), F.editBy('collab', t1)]))), false, 'a new editor changes the revision');
  assert.equal(sameRevision(rev, revisionOf(base, F.UNREADABLE)), false, 'unreadable never equals a readable revision');
  const authorized = await go({ issue: base, timeline: [], edits: F.edits([F.editBy('alice', t0)]), mode: 'owner-or-label' });
  assert.deepEqual(authorized.issueRevision, rev, 'the predicate returns the revision it authorized');
}
test('AC155: authorization binds the issue revision — a collaborator edit or rename of an OWNER/MEMBER issue → not-authorized; only-author edits → eligible; an admin label later than the edit → eligible in every mode; an edit after it → not-authorized; unreadable edits → not-authorized', ac155_authorizationBindsRevision);
