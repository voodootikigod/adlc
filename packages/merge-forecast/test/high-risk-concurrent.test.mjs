// Regression tests for #681 — the concurrent-conflict gate must fail on any
// pair with score >= conflictThreshold scheduled in the same wave, not only
// hard-vetoed (score 1.0, scope-overlap) pairs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { runForecast } from '../lib/forecast.mjs';

function mkTemp() {
  return mkdtempSync(join(tmpdir(), 'mf-hrc-test-'));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function mkTicket(id, opts = {}) {
  return { id, title: `Ticket ${id}`, ...opts };
}

function writeFile(root, relPath, content = '') {
  const full = join(root, relPath);
  mkdirSync(join(root, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function gitInit(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
}

function gitCommit(dir, files, message) {
  for (const [relPath, content] of Object.entries(files)) {
    writeFile(dir, relPath, content);
    execFileSync('git', ['add', relPath], { cwd: dir, stdio: 'ignore' });
  }
  execFileSync('git', ['commit', '-m', message, '--allow-empty'], { cwd: dir, stdio: 'ignore' });
}

// The proven namespace-collision fixture from forecast.test.mjs — two tickets
// scoped to route-colliding directory segments score >= 0.8, signal
// 'namespace-collision', hardVeto: false.
function namespaceCollisionTickets() {
  return [
    mkTicket('T1', { scope: ['app/votes/[pk]/**'] }),
    mkTicket('T2', { scope: ['app/votes/[voteKey]/**'] }),
  ];
}

function namespaceCollisionRepo(root) {
  gitInit(root);
  mkdirSync(join(root, 'app/votes/[pk]'), { recursive: true });
  mkdirSync(join(root, 'app/votes/[voteKey]'), { recursive: true });
  writeFileSync(join(root, 'app/votes/[pk]/page.tsx'), '// pk page');
  writeFileSync(join(root, 'app/votes/[voteKey]/details.tsx'), '// voteKey details');
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], { cwd: root, stdio: 'ignore' });
}

describe('merge-forecast: high-risk (non-veto) concurrent pairs gate-fail (#681)', () => {
  test('AC1 — namespace-collision (0.8) pair in the same wave gate-fails with no --width', async () => {
    const root = mkTemp();
    try {
      namespaceCollisionRepo(root);
      const tickets = namespaceCollisionTickets();
      const result = await runForecast({ tickets, root, conflictThreshold: 0.5 });

      // Precondition: this is the issue's own repro shape — a high-risk,
      // NON-veto pair, both in wave 1.
      const pair = result.pairs[0];
      assert.ok(pair.score >= 0.8, `precondition: expected score >= 0.8, got ${pair.score}`);
      assert.equal(pair.hardVeto, false, 'precondition: namespace-collision is not a hard veto');
      assert.equal(result.waves.length >= 1, true);
      assert.deepEqual([...result.waves[0]].sort(), ['T1', 'T2']);

      assert.ok(result.gateFailures.length > 0, 'expected a gate failure for the high-risk concurrent pair');
      const msg = result.gateFailures.join(' ');
      assert.match(msg, /T1.T2|T2.T1/, 'failure message should name the pair');
      assert.match(msg, /0\.8/, 'failure message should include the score');
      assert.match(msg, /namespace-collision/, 'failure message should include the signal');
    } finally {
      cleanup(root);
    }
  });

  test('AC2 — a below-threshold pair in the same wave does not gate-fail', async () => {
    const root = mkTemp();
    try {
      gitInit(root);
      // Two SEPARATE commits — committing them together would itself create a
      // co-change signal (pairCounts=1, fileCounts=1 -> 1/1*0.5 = 0.5), which
      // would defeat the point of this "genuinely unrelated" fixture.
      gitCommit(root, { 'src/unrelated-a.js': '// a' }, 'add a');
      gitCommit(root, { 'src/unrelated-b.js': '// b' }, 'add b');

      const tickets = [
        mkTicket('T1', { scope: ['src/unrelated-a.js'] }),
        mkTicket('T2', { scope: ['src/unrelated-b.js'] }),
      ];
      const result = await runForecast({ tickets, root, conflictThreshold: 0.5 });

      const pair = result.pairs[0];
      assert.ok(pair.score < 0.5, `precondition: expected score < 0.5, got ${pair.score}`);
      assert.equal(pair.hardVeto, false);
      assert.deepEqual([...result.waves[0]].sort(), ['T1', 'T2']);

      assert.equal(result.gateFailures.length, 0, 'a below-threshold pair must not gate-fail');
    } finally {
      cleanup(root);
    }
  });

  test('AC3 — a high-risk pair scheduled in DIFFERENT waves does not gate-fail', async () => {
    const root = mkTemp();
    try {
      namespaceCollisionRepo(root);
      // T3 collides with T1 (same fixture, renamed) but is delayed to wave 2
      // by an unrelated edge from T2 -> T3. T1 and T3 carry no edge between
      // them, so they remain parallel-eligible and ARE scored as a pair —
      // but topoWaves places T3 in wave 2 while T1 stays in wave 1.
      const tickets = [
        mkTicket('T1', { scope: ['app/votes/[pk]/**'] }),
        mkTicket('T2', { scope: ['unrelated/**'], edges: [{ to: 'T3' }] }),
        mkTicket('T3', { scope: ['app/votes/[voteKey]/**'] }),
      ];
      const result = await runForecast({ tickets, root, conflictThreshold: 0.5 });

      const pair = result.pairs.find((p) => (p.a === 'T1' && p.b === 'T3') || (p.a === 'T3' && p.b === 'T1'));
      assert.ok(pair, 'precondition: T1/T3 must still be scored as a parallel-eligible pair');
      assert.ok(pair.score >= 0.8, `precondition: expected score >= 0.8, got ${pair.score}`);
      assert.equal(result.waves.length, 2, 'precondition: T3 must land in wave 2, not wave 1');
      assert.ok(result.waves[0].includes('T1'));
      assert.ok(result.waves[1].includes('T3'));

      assert.equal(
        result.gateFailures.length,
        0,
        'a high-risk pair split across different waves is not scheduled concurrently and must not gate-fail'
      );
    } finally {
      cleanup(root);
    }
  });

  test('AC4 — regression: an existing hard-veto (score 1.0, scope-overlap) concurrent pair still gate-fails', async () => {
    const root = mkTemp();
    try {
      gitInit(root);
      gitCommit(root, { 'src/auth/index.js': '// auth' }, 'init');

      const tickets = [
        mkTicket('T1', { scope: ['src/auth/**'] }),
        mkTicket('T2', { scope: ['src/auth/**'] }),
      ];
      const result = await runForecast({ tickets, root, conflictThreshold: 0.5 });

      assert.equal(result.pairs[0].verdict, 'VETO');
      assert.equal(result.pairs[0].hardVeto, true);
      assert.ok(result.gateFailures.length > 0);
    } finally {
      cleanup(root);
    }
  });

  test('AC5 — --conflict-threshold changes which pairs trigger the concurrent gate', async () => {
    const root = mkTemp();
    try {
      namespaceCollisionRepo(root);
      const tickets = namespaceCollisionTickets();

      // A threshold ABOVE the pair's score (0.8) must not gate-fail it.
      const lenient = await runForecast({ tickets, root, conflictThreshold: 0.95 });
      assert.equal(lenient.gateFailures.length, 0, 'a threshold above the score must not gate-fail');

      // The default (0.5) threshold must still gate-fail it.
      const strict = await runForecast({ tickets, root, conflictThreshold: 0.5 });
      assert.ok(strict.gateFailures.length > 0, 'a threshold at or below the score must gate-fail');
    } finally {
      cleanup(root);
    }
  });
});
