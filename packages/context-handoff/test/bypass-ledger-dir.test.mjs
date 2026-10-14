// `handoff bypass --write` must refuse to report a recorded grant when the
// ledger it resolved has no handoffs directory: the enforcing hook reads the
// grant at the repo root, so a grant written under a subdirectory's own
// `.adlc` unblocks nothing while the CLI claims success (#608).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { handoffsDir, isEstablishedLedger, matchRecoveryCommand } from '../lib/index.mjs';

const HANDOFF_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handoff.mjs');
const KEY = 'a'.repeat(64);

function withRepo({ handoffs = true } = {}, fn) {
  const base = mkdtempSync(join(tmpdir(), 'adlc-bypass-dir-'));
  const root = realpathSync(base);
  try {
    mkdirSync(join(root, handoffs ? '.adlc/handoffs' : '.adlc'), { recursive: true });
    const sub = join(root, 'packages', 'x');
    mkdirSync(sub, { recursive: true });
    return fn({ root, sub });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function bypass(cwd, extra = []) {
  return spawnSync(process.execPath, [HANDOFF_CLI, 'bypass', '--session', 'sess-a', ...extra], {
    cwd,
    env: { ...process.env, ADLC_MANIFEST_KEY: KEY },
    encoding: 'utf8',
  });
}

test('AC1: --write from a subdirectory with no handoffs dir there exits 1 and writes nothing', () => {
  withRepo({}, ({ root, sub }) => {
    const r = bypass(sub, ['--write']);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(join(sub, '.adlc', 'handoffs')), `names the resolved path: ${r.stderr}`);
    assert.ok(r.stderr.includes('run from the repo root (an operator outside the hook may instead pass --dir <repo>/.adlc)'), `states the remedy: ${r.stderr}`);
    assert.ok(!`${r.stdout}${r.stderr}`.includes('recorded'), 'no success line');
    assert.equal(existsSync(join(sub, '.adlc')), false, 'nothing created under the subdirectory');
    assert.equal(existsSync(join(root, '.adlc', 'handoffs', 'sess-a.bypass-grant.json')), false);
  });
});

test('AC1: a handoffs entry that is a file, not a directory, is refused', () => {
  withRepo({ handoffs: false }, ({ root }) => {
    writeFileSync(join(root, '.adlc', 'handoffs'), 'not a dir');
    const r = bypass(root, ['--write']);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(!`${r.stdout}${r.stderr}`.includes('recorded'));
  });
});

test('AC2: --dir <root>/.adlc from a subdirectory writes the grant in the right tree', () => {
  withRepo({}, ({ root, sub }) => {
    const r = bypass(sub, ['--write', '--dir', join(root, '.adlc')]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /recorded bound grant/);
    assert.equal(existsSync(join(root, '.adlc', 'handoffs', 'sess-a.bypass-grant.json')), true);
    assert.equal(existsSync(join(sub, '.adlc')), false);
  });
});

test('AC2: --dir pointing at a ledger with no handoffs dir is refused the same way', () => {
  withRepo({ handoffs: false }, ({ root }) => {
    const r = bypass(root, ['--write', '--dir', join(root, '.adlc')]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(join(root, '.adlc', 'handoffs')), r.stderr);
  });
});

test('AC3 (not widened): the recovery grammar still rejects a bypass carrying --dir, exactly as the plugin twins do', () => {
  withRepo({}, ({ root }) => {
    const interpreterPath = join(root, 'node');
    const scriptPath = join(root, 'handoff.mjs');
    writeFileSync(interpreterPath, '');
    writeFileSync(scriptPath, '');
    const opts = { interpreterPath, scriptPath, sessionId: 'sess-a' };
    const base = `${interpreterPath} ${scriptPath} bypass --session sess-a --write`;
    assert.equal(matchRecoveryCommand(base, opts).matched, true);
    assert.equal(matchRecoveryCommand(`${base} --dir ${root}/.adlc`, opts).matched, false);
  });
});

test('AC4: repo-root invocation with an existing ledger is unchanged', () => {
  withRepo({}, ({ root }) => {
    const r = bypass(root, ['--write']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /handoff bypass: recorded bound grant for session=sess-a/);
    assert.equal(existsSync(join(root, '.adlc', 'handoffs', 'sess-a.bypass-grant.json')), true);
  });
});

test('dry-run prints the resolved ledger path, without requiring it to exist', () => {
  withRepo({}, ({ sub }) => {
    const r = bypass(sub);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(join(sub, '.adlc')), r.stdout);
    const j = JSON.parse(bypass(sub, ['--json']).stdout);
    assert.equal(j.ledger, join(sub, '.adlc'));
  });
});

test('isEstablishedLedger is true for a handoffs directory or a surviving sentinel, nothing else', () => {
  withRepo({}, ({ root, sub }) => {
    assert.equal(isEstablishedLedger(root), true);
    assert.equal(isEstablishedLedger(sub), false);
    writeFileSync(join(sub, '.adlc'), 'x');
    assert.equal(isEstablishedLedger(sub), false);
    assert.equal(isEstablishedLedger(join(root, 'missing')), false);
    assert.equal(handoffsDir(root), join(root, '.adlc', 'handoffs'));
  });
});

test('D0 recovery: a surviving .deny-store with handoffs/ deleted still accepts the unbound bypass from the repo root', () => {
  withRepo({ handoffs: false }, ({ root }) => {
    writeFileSync(join(root, '.adlc', '.deny-store'), '');
    const r = bypass(root, ['--write', '--unbound-reason', 'handoffs dir lost']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /recorded unbound grant/);
    assert.equal(existsSync(join(root, '.adlc', 'handoffs', 'sess-a.bypass-grant.json')), true);
    assert.equal(isEstablishedLedger(root), true);
  });
});

test('a sentinel that is a directory, not a file, does not establish the ledger', () => {
  withRepo({ handoffs: false }, ({ root }) => {
    mkdirSync(join(root, '.adlc', '.deny-store'));
    assert.equal(isEstablishedLedger(root), false);
  });
});

test('a BOUND bypass against sentinel-only D0 state is refused: it could not clear D0 and would be consumed for nothing', () => {
  withRepo({ handoffs: false }, ({ root }) => {
    writeFileSync(join(root, '.adlc', '.deny-store'), '');
    const r = bypass(root, ['--write']);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(!`${r.stdout}${r.stderr}`.includes('recorded'));
    assert.equal(existsSync(join(root, '.adlc', 'handoffs')), false, 'nothing written');
    assert.equal(isEstablishedLedger(root), false);
    assert.equal(isEstablishedLedger(root, { sentinelCounts: true }), true);
  });
});

test('an unbound bypass with neither handoffs/ nor a sentinel is still refused', () => {
  withRepo({ handoffs: false }, ({ root }) => {
    assert.strictEqual(isEstablishedLedger(root, { sentinelCounts: true }), false);
    const r = bypass(root, ['--write', '--unbound-reason', 'no ledger here']);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(existsSync(join(root, '.adlc', 'handoffs')), false);
  });
});
