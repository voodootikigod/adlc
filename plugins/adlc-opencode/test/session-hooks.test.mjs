// session-hooks.test.mjs — Phase C (T4): advisory session lifecycle checks.
// Pure/offline: injects a stub spawn, temp dirs only. Verifies the hooks are
// advisory (warnings, never throw) and no-op when not ADLC-initialized.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPreflight, auditGateManifest, auditAdversarialReview } from '../lib/session-hooks.mjs';
import { adlcRailsGuard } from '../index.mjs';

const mkroot = () => mkdtempSync(join(tmpdir(), 'oc-t4-'));
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
test('checkPreflight: no .adlc/tickets.json → skipped no-op', () => {
  const root = mkroot();
  try {
    const r = checkPreflight(root, { spawnImpl: stub({}), env: { ADLC_P4_ENFORCEMENT: '1' } });
    assert.equal(r.skipped, true);
    assert.deepEqual(r.warnings, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkPreflight: adlc missing + dirty tree + enforcement off → 3 advisory warnings', () => {
  const root = initAdlc(mkroot());
  try {
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkPreflight: all good → ready, no warnings', () => {
  const root = initAdlc(mkroot());
  try {
    const spawnImpl = stub({
      'adlc --version': { status: 0, stdout: '1.1.0\n' },
      'git status': { status: 0, stdout: '' },
    });
    const r = checkPreflight(root, { spawnImpl, env: { ADLC_P4_ENFORCEMENT: '1' } });
    assert.equal(r.ready, true);
    assert.deepEqual(r.warnings, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- auditGateManifest ----
test('auditGateManifest: no manifest → skipped no-op', () => {
  const root = initAdlc(mkroot());
  try {
    const r = auditGateManifest(root, { spawnImpl: stub({}) });
    assert.equal(r.skipped, true);
    assert.equal(r.ok, true);
    assert.equal(r.warning, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditGateManifest: verify non-zero → advisory warning', () => {
  const root = initAdlc(mkroot());
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1}\n');
  try {
    const spawnImpl = stub({ 'adlc gate-manifest verify': { status: 2, stdout: 'chain broken at seq 1' } });
    const r = auditGateManifest(root, { spawnImpl });
    assert.equal(r.ok, false);
    assert.match(r.warning, /chain broken/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditGateManifest: verify ok → no warning', () => {
  const root = initAdlc(mkroot());
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1}\n');
  try {
    const r = auditGateManifest(root, { spawnImpl: stub({ 'adlc gate-manifest verify': { status: 0, stdout: '{}' } }) });
    assert.equal(r.ok, true);
    assert.equal(r.warning, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- auditAdversarialReview (issue #59: mechanical local trigger) ----

test('auditAdversarialReview: not ADLC-initialized → skipped no-op', () => {
  const root = mkroot();
  try {
    const r = auditAdversarialReview(root, { spawnImpl: stub({}) });
    assert.equal(r.skipped, true);
    assert.equal(r.needed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditAdversarialReview: no changed paths → not needed', () => {
  const root = initAdlc(mkroot());
  try {
    const r = auditAdversarialReview(root, { spawnImpl: stub({}), env: {} });
    assert.equal(r.needed, false);
    assert.equal(r.warning, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditAdversarialReview: changed path is NOT risk-tier → not needed', () => {
  const root = initAdlc(mkroot());
  try {
    const spawnImpl = stub({ 'git status': { status: 0, stdout: ' M docs/readme.md\n' } });
    const r = auditAdversarialReview(root, { spawnImpl, env: {} });
    assert.equal(r.needed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditAdversarialReview: risk-tier path changed, no manifest at all → needed', () => {
  const root = initAdlc(mkroot());
  try {
    const spawnImpl = stub({ 'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' } });
    const r = auditAdversarialReview(root, { spawnImpl, env: {} });
    assert.equal(r.needed, true);
    assert.match(r.warning, /risk-gated/);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].tier, 'auth-trust-boundary');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditAdversarialReview: quoted git-status path (space in filename) is unquoted before risk-tier matching → needed', () => {
  const root = initAdlc(mkroot());
  try {
    // git status --porcelain C-quotes paths with a space, e.g. ` M "secrets/api key.pem"`;
    // a naive slice(3) parse would keep the literal quotes and miss the **/secrets/** match.
    const spawnImpl = stub({ 'git status': { status: 0, stdout: ' M "secrets/api key.pem"\n' } });
    const r = auditAdversarialReview(root, { spawnImpl, env: {} });
    assert.equal(r.needed, true);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].path, 'secrets/api key.pem');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditAdversarialReview: risk-tier path changed but adlc unreachable → still needed (cannot prove satisfied)', () => {
  const root = initAdlc(mkroot());
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"rails-bypass"}\n');
  try {
    const spawnImpl = stub({
      'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
      'adlc gate-manifest show': { status: 1, error: new Error('ENOENT') },
    });
    const r = auditAdversarialReview(root, { spawnImpl, env: {} });
    assert.equal(r.needed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditAdversarialReview: adversarial-review already recorded (untargeted) → not needed', () => {
  const root = initAdlc(mkroot());
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review"}\n');
  try {
    const spawnImpl = stub({
      'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
      'adlc gate-manifest show': { status: 0, stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review' }] }) },
    });
    const r = auditAdversarialReview(root, { spawnImpl, env: {} });
    assert.equal(r.needed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditAdversarialReview: recorded for the active ticket (ADLC_TICKET) → not needed', () => {
  const root = initAdlc(mkroot());
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review","ticket":"T1"}\n');
  try {
    const spawnImpl = stub({
      'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
      'adlc gate-manifest show': { status: 0, stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review', ticket: 'T1' }] }) },
    });
    const r = auditAdversarialReview(root, { spawnImpl, env: { ADLC_TICKET: 'T1' } });
    assert.equal(r.needed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditAdversarialReview: recorded for a DIFFERENT ticket than active → still needed', () => {
  const root = initAdlc(mkroot());
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review","ticket":"T2"}\n');
  try {
    const spawnImpl = stub({
      'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
      'adlc gate-manifest show': { status: 0, stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review', ticket: 'T2' }] }) },
    });
    const r = auditAdversarialReview(root, { spawnImpl, env: { ADLC_TICKET: 'T1' } });
    assert.equal(r.needed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditAdversarialReview: conflicting ADLC_TICKET vs current-ticket.json degrades to unscoped (advisory, does not fail closed)', () => {
  const root = initAdlc(mkroot());
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T9' }));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review"}\n');
  try {
    const spawnImpl = stub({
      'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
      'adlc gate-manifest show': { status: 0, stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review' }] }) },
    });
    // ADLC_TICKET ('T1') conflicts with current-ticket.json ('T9') — must not throw
    // or fail closed; degrades to "no active ticket", so the untargeted record above still satisfies it.
    const r = auditAdversarialReview(root, { spawnImpl, env: { ADLC_TICKET: 'T1' } });
    assert.equal(r.needed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditAdversarialReview: recorded with --files for a DIFFERENT (non-overlapping) path → still needed', () => {
  const root = initAdlc(mkroot());
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review","files":{"unrelated/file.mjs":"deadbeef"}}\n');
  try {
    const spawnImpl = stub({
      'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
      'adlc gate-manifest show': {
        status: 0,
        stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review', files: { 'unrelated/file.mjs': 'deadbeef' } }] }),
      },
    });
    const r = auditAdversarialReview(root, { spawnImpl, env: {} });
    assert.equal(r.needed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditAdversarialReview: recorded with --files overlapping the gated path → not needed', () => {
  const root = initAdlc(mkroot());
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"adversarial-review","files":{"src/auth/login.mjs":"deadbeef"}}\n');
  try {
    const spawnImpl = stub({
      'git status': { status: 0, stdout: '?? src/auth/login.mjs\n' },
      'adlc gate-manifest show': {
        status: 0,
        stdout: JSON.stringify({ entries: [{ seq: 1, gate: 'adversarial-review', files: { 'src/auth/login.mjs': 'deadbeef' } }] }),
      },
    });
    const r = auditAdversarialReview(root, { spawnImpl, env: {} });
    assert.equal(r.needed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- the real hooks are advisory: never throw ----
test('session.created / session.idle hooks never throw (advisory)', async () => {
  const root = initAdlc(mkroot());
  try {
    const hooks = await adlcRailsGuard({ worktree: root });
    await hooks['session.created'](); // must resolve, not reject
    await hooks['session.idle']();
    assert.ok(typeof hooks['session.created'] === 'function');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
