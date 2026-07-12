import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveDeps } from '../lib/live-deps.mjs';
import { runFleet } from '../lib/run.mjs';

// The regression test for github #164: the LIVE deps (not just async fakes) must
// run non-overlapping tickets' workers CONCURRENTLY. A synchronous spawn would
// block the event loop and serialize them; this proves the async conversion.

const T = (id, scope) => ({ id, title: id, scope, body: 'do', edges: [] });

function fakeGit() {
  return () => (...args) => {
    const verb = args[0];
    if (verb === 'diff') return ''; // no out-of-scope changes (this test targets concurrency, not the gate)
    if (verb === 'status') return '';
    if (verb === 'show') throw new Error('no template at rev');
    if (verb === 'rev-parse') return 'SHA';
    return '';
  };
}

test('two non-overlapping tickets dispatch CONCURRENTLY through buildLiveDeps (#164)', async () => {
  let pendingWorkers = 0;
  let maxConcurrentWorkers = 0;
  let releaseWorkers;
  const workerGate = new Promise((res) => { releaseWorkers = res; });

  const io = {
    git: fakeGit(),
    adlc: () => ({ status: 0, stdout: '{"detected":false}' }),
    adlcAsync: async () => ({ status: 0, stdout: '' }),
    // The claude worker blocks (async, non-blocking to the event loop) until we
    // release it; the gate (bwrap) resolves immediately.
    spawnWorker: async (cmd) => {
      if (cmd === 'claude') {
        pendingWorkers += 1;
        maxConcurrentWorkers = Math.max(maxConcurrentWorkers, pendingWorkers);
        await workerGate;
        pendingWorkers -= 1;
        return { status: 0, stdout: 'TICKET-DONE', stderr: '' };
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    readFile: () => undefined,
    exists: () => false,
    mkdirp: () => {},
    writeJson: () => {},
    ensureGitignore: () => {},
    env: { PATH: '/usr/bin' },
    hasGh: () => false,
  };

  const config = { gate: { test: 'true' }, prosecuteFailOn: 'medium', concurrency: 2, base: 'main', baseSha: 'BASE' };
  const deps = buildLiveDeps({
    repo: '/repo', config, statusDir: undefined,
    sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    io,
  });

  const all = [T('T1', ['src/a/**']), T('T2', ['src/b/**'])]; // non-overlapping
  const runP = runFleet({ all, runId: 'k', config, deps });

  // Give both admitted tickets time to reach their (blocked) worker dispatch.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pendingWorkers, 2, 'both workers are in flight at once — the live layer is NOT serialized (#164)');

  releaseWorkers();
  const summary = await runP;
  assert.equal(maxConcurrentWorkers, 2, 'the live pool ran two workers concurrently');
  assert.deepEqual(Object.values(summary.results).sort(), ['merged', 'merged']);
});
