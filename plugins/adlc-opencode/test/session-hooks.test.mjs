// session-hooks.test.mjs — Phase C (T4): advisory session lifecycle checks.
// Pure/offline: injects a stub spawn, temp dirs only. Verifies the hooks are
// advisory (warnings, never throw) and no-op when not ADLC-initialized.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPreflight, auditGateManifest } from '../lib/session-hooks.mjs';
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
