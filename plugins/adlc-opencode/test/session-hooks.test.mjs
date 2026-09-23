// session-hooks.test.mjs — Phase C (T4): advisory session lifecycle checks.
// Pure/offline: injects a stub spawn, temp dirs only. Verifies the hooks are
// advisory (warnings, never throw) and no-op when not ADLC-initialized.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { checkPreflight, auditGateManifest, auditAdversarialReview } from '../lib/session-hooks.mjs';
import { adlcRailsGuard } from '../index.mjs';

const mkroot = (t) => tmp(t, 'oc-t4-');
function initAdlc(root) {
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), '{"tickets":[]}');
  return root;
}
// spawn stub: route by bin → canned {status, stdout, stderr, error}
function stub(map) {
  return (bin, args) => {
    const key = `${bin} ${(args || []).join(' ')}`;
    for (const [prefix, val] of Object.entries(map)) if (key.startsWith(prefix)) return val;
    return { status: 0, stdout: '', stderr: '' };
  };
}

// ---- checkPreflight ----
test('checkPreflight: no .adlc/tickets.json → skipped no-op', (t) => {
  const root = mkroot(t);
  const r = checkPreflight(root, { spawnImpl: stub({}), env: { ADLC_P4_ENFORCEMENT: '1' } });
  assert.equal(r.skipped, true);
  assert.deepEqual(r.warnings, []);
});

test('checkPreflight: adlc missing + dirty tree + enforcement off → 3 advisory warnings', (t) => {
  const root = initAdlc(mkroot(t));
  const spawnImpl = stub({
    'adlc --version': { status: 1, error: new Error('ENOENT') },
    'git status': { status: 0, stdout: ' M file.txt\n' },
  });
  const r = checkPreflight(root, { spawnImpl, env: {} });
  assert.equal(r.skipped, false);
  assert.equal(r.ready, false);
  assert.equal(r.warnings.length, 3);
  assert.ok(r.warnings.some((w) => /adlc.* is not on PATH/.test(w)));
  assert.ok(r.warnings.some((w) => /dirty/.test(w)));
  assert.ok(r.warnings.some((w) => /ADLC_P4_ENFORCEMENT/.test(w)));
});

test('checkPreflight: all good → ready, no warnings', (t) => {
  const root = initAdlc(mkroot(t));
  const spawnImpl = stub({
    'adlc --version': { status: 0, stdout: '1.1.0\n' },
    'git status': { status: 0, stdout: '' },
  });
  const r = checkPreflight(root, { spawnImpl, env: { ADLC_P4_ENFORCEMENT: '1' } });
  assert.equal(r.ready, true);
  assert.deepEqual(r.warnings, []);
});

// ---- auditGateManifest ----
test('auditGateManifest: no manifest → skipped no-op', (t) => {
  const root = initAdlc(mkroot(t));
  const r = auditGateManifest(root, { spawnImpl: stub({}) });
  assert.equal(r.skipped, true);
  assert.equal(r.ok, true);
  assert.equal(r.warning, null);
});

test('auditGateManifest: verify non-zero → advisory warning', (t) => {
  const root = initAdlc(mkroot(t));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1}\n');
  const spawnImpl = stub({ 'adlc gate-manifest verify': { status: 2, stdout: 'chain broken at seq 1' } });
  const r = auditGateManifest(root, { spawnImpl });
  assert.equal(r.ok, false);
  assert.match(r.warning, /chain broken/);
});

test('auditGateManifest: verify ok → no warning', (t) => {
  const root = initAdlc(mkroot(t));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1}\n');
  const r = auditGateManifest(root, { spawnImpl: stub({ 'adlc gate-manifest verify': { status: 0, stdout: '{}' } }) });
  assert.equal(r.ok, true);
  assert.equal(r.warning, null);
});

// #378: pin that the verify spawn actually passes --allow-legacy-unsigned — a
// revert of that flag would restore the "cry wolf on legacy history" bug
// without any test here catching it (stub() above matches on a bin+verb prefix
// alone, so it can't see whether the flag was dropped).
test('auditGateManifest: verify is called with --allow-legacy-unsigned', (t) => {
  const root = initAdlc(mkroot(t));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1}\n');
  const calls = [];
  const spy = (bin, args) => { calls.push({ bin, args }); return { status: 0, stdout: '{}', stderr: '' }; };
  auditGateManifest(root, { spawnImpl: spy });
  const verifyCall = calls.find((c) => c.bin === 'adlc' && c.args.includes('verify'));
  assert.ok(verifyCall, 'a gate-manifest verify call was made');
  assert.ok(verifyCall.args.includes('--allow-legacy-unsigned'), 'verify is called with --allow-legacy-unsigned');
});

// ---- auditAdversarialReview (issue #59: mechanical local trigger) ----

test('auditAdversarialReview: not ADLC-initialized → skipped no-op', (t) => {
  const root = mkroot(t);
  const r = auditAdversarialReview(root, { spawnImpl: stub({}) });
  assert.equal(r.skipped, true);
  assert.equal(r.needed, false);
});

test('auditAdversarialReview: no changed paths → not needed', (t) => {
  const root = initAdlc(mkroot(t));
  const r = auditAdversarialReview(root, { spawnImpl: stub({}), env: {} });
  assert.equal(r.needed, false);
  assert.equal(r.warning, null);
});

test('auditAdversarialReview: changed path is NOT risk-tier → not needed', (t) => {
  const root = initAdlc(mkroot(t));
  const spawnImpl = stub({ 'git status': { status: 0, stdout: ' M docs/readme.md\n' } });
  const r = auditAdversarialReview(root, { spawnImpl, env: {} });
  assert.equal(r.needed, false);
});

test('auditAdversarialReview: risk-tier path changed, no manifest at all → needed', (t) => {
  const root = initAdlc(mkroot(t));
  const spawnImpl = stub({ 'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' } });
  const r = auditAdversarialReview(root, { spawnImpl, env: {} });
  assert.equal(r.needed, true);
  assert.match(r.warning, /risk-gated/);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].tier, 'auth-trust-boundary');
});

// Regression for the fbf4a38 fix: the remediation text once told operators to
// run `gate-manifest record adversarial-review --evidence '...'`, but
// `gate-manifest record` only accepts --ticket/--data/--files and throws
// ERR_PARSE_ARGS_UNKNOWN_OPTION on --evidence. Assert the printed command uses
// only real flags so this specific regression can't silently creep back in.
test('auditAdversarialReview: warning remediation text uses --files/--data, never the non-existent --evidence flag', (t) => {
  const root = initAdlc(mkroot(t));
  const spawnImpl = stub({ 'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' } });
  const r = auditAdversarialReview(root, { spawnImpl, env: {} });
  assert.match(r.warning, /gate-manifest record adversarial-review/);
  assert.match(r.warning, /--files/);
  assert.match(r.warning, /--data/);
  assert.doesNotMatch(r.warning, /--evidence/);
});

test('auditAdversarialReview: quoted git-status path (space in filename) is unquoted before risk-tier matching → needed', (t) => {
  const root = initAdlc(mkroot(t));
  // git status --porcelain C-quotes paths with a space, e.g. ` M "secrets/api key.pem"`;
  // a naive slice(3) parse would keep the literal quotes and miss the **/secrets/** match.
  const spawnImpl = stub({ 'git status': { status: 0, stdout: ' M "secrets/api key.pem"\n' } });
  const r = auditAdversarialReview(root, { spawnImpl, env: {} });
  assert.equal(r.needed, true);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].path, 'secrets/api key.pem');
});

test('auditAdversarialReview: risk-tier path changed but adlc unreachable → still needed (cannot prove satisfied)', (t) => {
  const root = initAdlc(mkroot(t));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"rails-bypass"}\n');
  const spawnImpl = stub({
    'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
    'adlc gate-manifest show': { status: 1, error: new Error('ENOENT') },
  });
  const r = auditAdversarialReview(root, { spawnImpl, env: {} });
  assert.equal(r.needed, true);
});

test('auditAdversarialReview: adversarial-review already recorded (untargeted) → not needed', (t) => {
  const root = initAdlc(mkroot(t));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review"}\n');
  const spawnImpl = stub({
    'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
    'adlc gate-manifest show': { status: 0, stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review' }] }) },
  });
  const r = auditAdversarialReview(root, { spawnImpl, env: {} });
  assert.equal(r.needed, false);
});

test('auditAdversarialReview: recorded for the active ticket (ADLC_TICKET) → not needed', (t) => {
  const root = initAdlc(mkroot(t));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review","ticket":"T1"}\n');
  const spawnImpl = stub({
    'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
    'adlc gate-manifest show': { status: 0, stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review', ticket: 'T1' }] }) },
  });
  const r = auditAdversarialReview(root, { spawnImpl, env: { ADLC_TICKET: 'T1' } });
  assert.equal(r.needed, false);
});

test('auditAdversarialReview: recorded for a DIFFERENT ticket than active → still needed', (t) => {
  const root = initAdlc(mkroot(t));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review","ticket":"T2"}\n');
  const spawnImpl = stub({
    'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
    'adlc gate-manifest show': { status: 0, stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review', ticket: 'T2' }] }) },
  });
  const r = auditAdversarialReview(root, { spawnImpl, env: { ADLC_TICKET: 'T1' } });
  assert.equal(r.needed, true);
});

test('auditAdversarialReview: conflicting ADLC_TICKET vs current-ticket.json degrades to unscoped (advisory, does not fail closed)', (t) => {
  const root = initAdlc(mkroot(t));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T9' }));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review"}\n');
  const spawnImpl = stub({
    'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
    'adlc gate-manifest show': { status: 0, stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review' }] }) },
  });
  // ADLC_TICKET ('T1') conflicts with current-ticket.json ('T9') — must not throw
  // or fail closed; degrades to "no active ticket", so the untargeted record above still satisfies it.
  const r = auditAdversarialReview(root, { spawnImpl, env: { ADLC_TICKET: 'T1' } });
  assert.equal(r.needed, false);
});

test('auditAdversarialReview: recorded with --files for a DIFFERENT (non-overlapping) path → still needed', (t) => {
  const root = initAdlc(mkroot(t));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review","files":{"unrelated/file.mjs":"deadbeef"}}\n');
  const spawnImpl = stub({
    'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
    'adlc gate-manifest show': {
      status: 0,
      stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review', files: { 'unrelated/file.mjs': 'deadbeef' } }] }),
    },
  });
  const r = auditAdversarialReview(root, { spawnImpl, env: {} });
  assert.equal(r.needed, true);
});

test('auditAdversarialReview: recorded with --files overlapping the gated path → not needed', (t) => {
  const root = initAdlc(mkroot(t));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review","files":{"src/auth/login.mjs":"deadbeef"}}\n');
  const spawnImpl = stub({
    'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
    'adlc gate-manifest show': {
      status: 0,
      stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review', files: { 'src/auth/login.mjs': 'deadbeef' } }] }),
    },
  });
  const r = auditAdversarialReview(root, { spawnImpl, env: {} });
  assert.equal(r.needed, false);
});

test('auditAdversarialReview: diffs against the merge-base, not the trunk candidate\'s live tip', (t) => {
  const root = initAdlc(mkroot(t));
  const spawnImpl = stub({
    'git status': { status: 0, stdout: '' },
    'git ls-files': { status: 0, stdout: '' },
    'git rev-parse --verify --quiet main^{commit}': { status: 0, stdout: '' },
    'git merge-base main HEAD': { status: 0, stdout: 'deadbeefcafe\n' },
    'git diff --name-only deadbeefcafe --': { status: 0, stdout: 'src/auth/login.mjs\n' },
    // If the implementation regressed to diffing straight against the
    // candidate's tip, THIS is the call it would make instead — assert
    // that path never surfaces.
    'git diff --name-only main --': { status: 0, stdout: 'docs/unrelated-trunk-only-change.md\n' },
  });
  const r = auditAdversarialReview(root, { spawnImpl, env: {} });
  assert.equal(r.needed, true);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].path, 'src/auth/login.mjs');
});

test('auditAdversarialReview: merge-base unresolvable → diff step skipped (no false positives from a bad base)', (t) => {
  const root = initAdlc(mkroot(t));
  const spawnImpl = stub({
    'git status': { status: 0, stdout: '' },
    'git ls-files': { status: 0, stdout: '' },
    'git rev-parse --verify --quiet main^{commit}': { status: 0, stdout: '' },
    'git merge-base main HEAD': { status: 1, stdout: '', stderr: 'fatal: no merge base' },
    'git diff --name-only main --': { status: 0, stdout: 'src/auth/login.mjs\n' },
  });
  const r = auditAdversarialReview(root, { spawnImpl, env: {} });
  assert.equal(r.needed, false);
});

// Regression for 00cd52e: `main` can EXIST as a ref (orphan branch, stale ref
// after a history rewrite, shallow clone) yet share no common history with
// HEAD, so `git merge-base main HEAD` fails even though `git rev-parse
// --verify main^{commit}` succeeds. The old `.find(existsAsRef)` logic stopped
// at the first EXISTING candidate and never tried `master`, silently dropping
// the committed-diff contribution to `changed` even though `master` is a real,
// resolvable ancestor. This test only passes if the retry-on-merge-base-
// failure loop keeps trying candidates past an existing-but-unrelated `main`.
test('auditAdversarialReview: main exists but shares no history with HEAD → retries master, which resolves', (t) => {
  const root = initAdlc(mkroot(t));
  const spawnImpl = stub({
    'git status': { status: 0, stdout: '' },
    'git ls-files': { status: 0, stdout: '' },
    // `main` exists as a ref...
    'git rev-parse --verify --quiet main^{commit}': { status: 0, stdout: '' },
    // ...but has no common ancestor with HEAD (orphan/stale/shallow).
    'git merge-base main HEAD': { status: 1, stdout: '', stderr: 'fatal: no merge base' },
    // `master` is the real, resolvable ancestor — the retry loop must reach it.
    'git rev-parse --verify --quiet master^{commit}': { status: 0, stdout: '' },
    'git merge-base master HEAD': { status: 0, stdout: 'cafebabe1234\n' },
    'git diff --name-only cafebabe1234 --': { status: 0, stdout: 'src/auth/login.mjs\n' },
  });
  const r = auditAdversarialReview(root, { spawnImpl, env: {} });
  assert.equal(r.needed, true);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].path, 'src/auth/login.mjs');
});

// ---- the real hooks are advisory: never throw ----
test('session.created / session.idle hooks never throw (advisory)', async (t) => {
  const root = initAdlc(mkroot(t));
  const hooks = await adlcRailsGuard({ worktree: root });
  await hooks['session.created'](); // must resolve, not reject
  await hooks['session.idle']();
  assert.ok(typeof hooks['session.created'] === 'function');
});
