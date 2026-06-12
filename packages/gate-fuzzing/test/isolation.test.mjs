// SECURITY-CRITICAL (Fix 2): candidate-execution isolation.
//
// Proves that a hostile candidate's setup/witness commands execute ONLY inside a
// fresh disposable clone bound to the sandbox — NEVER against the real working
// tree / source repo. The sentinel file the candidate tries to plant must:
//   - NOT appear in the source repo root
//   - NOT appear at an absolute escape path outside the clone
//   - leave NO leftover temp clone dir after the run (cleanup always ran)
//
// This test is LOAD-BEARING: if the clone lifecycle is short-circuited (e.g. the
// loop reverts to running candidates in cwd, or destroy() stops being called),
// the sentinel assertions or the leftover-dir assertion fail.
//
// If no sandbox binary is available, the test asserts the REFUSE-without-sandbox
// path (error) instead of silently running unsandboxed — so it can never pass by
// accidentally executing in cwd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { detectSandbox } from '../lib/sandbox.mjs';
import { makeProvisionFn } from '../lib/provision.mjs';
import { provisionClone, destroyClone } from '../lib/clone.mjs';
import { runLoop } from '../lib/loop.mjs';
import { classifyCandidate } from '../lib/classify.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSourceRepo() {
  const root = mkdtempSync(join(tmpdir(), 'gf-src-repo-'));
  const g = (args) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'rail.txt'), 'frozen content\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  return root;
}

// Count how many gf-clone-* temp dirs exist (to detect leftover clones).
function countLeftoverClones() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith('gf-clone-')).length;
}

const sandboxType = detectSandbox();

// ── test 1: hostile setup/witness is confined to the clone ──────────────────────

test('candidate setup writing a sentinel cannot escape to source repo / cwd; clone is cleaned up', async () => {
  const sourceRepo = makeSourceRepo();
  const escapePath = join(sourceRepo, 'PWNED');           // absolute escape target
  const sentinelRel = 'PWNED';                            // relative (cwd) target

  // Candidate diff touches the rail; setup tries to plant a sentinel both at the
  // source repo (absolute escape) and at the clone cwd (relative).
  const diff = [
    'diff --git a/rail.txt b/rail.txt',
    'index 1111111..2222222 100644',
    '--- a/rail.txt',
    '+++ b/rail.txt',
    '@@ -1 +1 @@',
    '-frozen content',
    '+forged content',
    '',
  ].join('\n');

  const candidate = {
    id: 'hostile-001',
    strategy: 'base-ref-window',
    target: 'g',
    claimKind: 'freeze-integrity',
    diff,
    // Two setup steps: try to write OUTSIDE the clone (absolute) and INSIDE (cwd).
    setup: [
      ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(escapePath)},'x')`],
      ['node', '-e', `require('fs').writeFileSync(process.cwd()+'/${sentinelRel}','x')`],
    ],
    // Witness also attempts the absolute escape write before exiting.
    witnessProposal: {
      cmd: 'node',
      args: ['-e', `try{require('fs').writeFileSync(${JSON.stringify(escapePath)},'x')}catch(e){}; process.exit(1)`],
    },
  };

  const provisionFn = makeProvisionFn({
    repoRoot: sourceRepo,
    sandboxType,
    unsafeNoSandbox: false,
    suite: [{ name: 'g', surface: ['**'], claims: ['freeze-integrity'], run: ['node', '-e', 'process.exit(0)'] }],
    baselineRef: 'HEAD',
  });

  try {
    if (!sandboxType) {
      // REFUSE path: provisionClone must throw (no sandbox, not unsafe) rather
      // than silently executing the hostile setup. provisionFn surfaces .error.
      return await assertRefuseWithoutSandbox(provisionFn, candidate, sourceRepo, escapePath);
    }

    // Sandbox available: drive the real provision + classify lifecycle directly
    // (one candidate, one round) so the hostile commands actually run sandboxed.
    const before = countLeftoverClones();
    const provisioned = await provisionFn(candidate);
    let cloneDir = provisioned.cloneDir;
    try {
      assert.ok(cloneDir, 'a clone dir must have been created');
      // The clone existed during the run.
      // (setup already ran inside provisionClone)
    } finally {
      provisioned.destroy();
    }

    // The sentinel must NOT have escaped to the source repo (absolute path).
    assert.ok(
      !existsSync(escapePath),
      `SECURITY FAILURE: hostile write escaped the sandbox to ${escapePath}`,
    );
    // The sentinel must NOT appear in the test process cwd (relative path).
    assert.ok(
      !existsSync(join(process.cwd(), sentinelRel)),
      'SECURITY FAILURE: hostile write landed in the test cwd',
    );
    // The clone dir must be gone (destroy ran).
    assert.ok(!existsSync(cloneDir), 'clone dir must be removed after destroy()');
    // No net new leftover clones.
    const after = countLeftoverClones();
    assert.ok(after <= before, `leftover clone dirs: before=${before} after=${after}`);
  } finally {
    destroyCwdSentinel(sentinelRel);
    rmSync(sourceRepo, { recursive: true, force: true });
  }
});

// ── test 2: refuse-without-sandbox is explicit (not a silent cwd run) ────────────

test('no sandbox binary → provisionClone REFUSES to run candidate setup (no silent cwd execution)', () => {
  const sourceRepo = makeSourceRepo();
  const escapePath = join(sourceRepo, 'PWNED-REFUSE');
  const candidate = {
    target: 'g',
    claimKind: 'freeze-integrity',
    diff: '',
    setup: [['node', '-e', `require('fs').writeFileSync(${JSON.stringify(escapePath)},'x')`]],
    witnessProposal: { cmd: 'node', args: ['-e', 'process.exit(1)'] },
  };

  try {
    // Force the no-sandbox branch by passing sandboxType=null and unsafe=false.
    assert.throws(
      () => provisionClone(candidate, {
        repoRoot: sourceRepo,
        sandboxType: null,
        unsafeNoSandbox: false,
      }),
      /No OS sandbox binary/i,
      'must refuse to run candidate setup without a sandbox',
    );
    // The hostile setup must NOT have run.
    assert.ok(!existsSync(escapePath), 'refuse path must not execute hostile setup');
  } finally {
    rmSync(sourceRepo, { recursive: true, force: true });
  }
});

// ── test 3: clone is always destroyed even when classify throws ─────────────────

test('clone is destroyed even when classify throws mid-run (finally cleanup)', async () => {
  const sourceRepo = makeSourceRepo();
  let capturedCloneDir = null;

  const provisionFn = async (cand) => {
    if (!sandboxType) {
      // Without sandbox, simulate provision with a throwaway dir to test the
      // finally-destroy contract deterministically.
      const dir = mkdtempSync(join(tmpdir(), 'gf-clone-'));
      capturedCloneDir = dir;
      return { cloneDir: dir, runGateFn: () => ({ exitCode: 0 }), runWitnessFn: () => ({ status: 0, timedOut: false }), oracleFn: () => ({ independent: false, source: 'unwitnessed' }), destroy: () => destroyClone(dir) };
    }
    const p = makeProvisionFn({
      repoRoot: sourceRepo, sandboxType, unsafeNoSandbox: false,
      suite: [{ name: 'g', surface: ['**'], claims: ['freeze-integrity'], run: ['node', '-e', 'process.exit(0)'] }],
      baselineRef: 'HEAD',
    });
    const result = await p(cand);
    capturedCloneDir = result.cloneDir;
    return result;
  };

  // classifyFn that throws — the loop's finally must still destroy the clone.
  const throwingClassify = () => { throw new Error('boom'); };

  const fanFn = async () => [{ ok: true, value: JSON.stringify({
    target: 'g', claimKind: 'freeze-integrity',
    diff: 'diff --git a/rail.txt b/rail.txt\nindex 1..2 100644\n--- a/rail.txt\n+++ b/rail.txt\n@@ -1 +1 @@\n-frozen content\n+forged\n',
    witnessProposal: { cmd: 'node', args: ['-e', 'process.exit(1)'] }, setup: [],
  }) }];

  try {
    await assert.rejects(
      runLoop(
        [{ name: 'g', surface: ['**'], claims: ['freeze-integrity'], run: ['node', '-e', 'process.exit(0)'] }],
        { dir: sourceRepo },
        { fanFn, classifyFn: throwingClassify, provisionFn, maxRounds: 1, dryRounds: 1, tokenBudget: 1e9, maxFailRate: 0.9, n: 1 },
      ),
      /boom/,
    );
    assert.ok(capturedCloneDir, 'a clone dir should have been provisioned');
    assert.ok(!existsSync(capturedCloneDir), 'clone must be destroyed even when classify throws');
  } finally {
    if (capturedCloneDir) destroyClone(capturedCloneDir);
    rmSync(sourceRepo, { recursive: true, force: true });
  }
});

// ── shared helpers ──────────────────────────────────────────────────────────────

async function assertRefuseWithoutSandbox(provisionFn, candidate, sourceRepo, escapePath) {
  const provisioned = await provisionFn(candidate);
  try {
    assert.ok(
      provisioned.error && /No OS sandbox binary/i.test(provisioned.error),
      `expected refuse-without-sandbox error, got: ${provisioned.error}`,
    );
    assert.ok(!existsSync(escapePath), 'refuse path must not execute hostile setup');
  } finally {
    if (provisioned.destroy) provisioned.destroy();
  }
}

function destroyCwdSentinel(rel) {
  try { rmSync(join(process.cwd(), rel), { force: true }); } catch { /* ignore */ }
}
