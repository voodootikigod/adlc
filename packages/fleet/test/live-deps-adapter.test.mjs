import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveDeps } from '../lib/live-deps.mjs';

function fakeGit() {
  return () => (...args) => {
    const v = args[0];
    if (v === 'diff') return '';
    if (v === 'rev-parse') return 'SHA';
    return '';
  };
}
function fakeIo(rec, env) {
  return {
    git: fakeGit(),
    adlc: () => ({ status: 0, stdout: '{}' }),
    adlcAsync: async () => ({ status: 0, stdout: '' }),
    spawnWorker: async (cmd, args, opts) => { rec.push({ cmd, args, env: opts?.env }); return { status: 0, stdout: 'TICKET-DONE', stderr: '' }; },
    readFile: () => undefined, exists: () => false, mkdirp: () => {}, writeJson: () => {}, ensureGitignore: () => {},
    env, hasGh: () => false,
  };
}
const env = { PATH: '/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-anthropic', OPENAI_API_KEY: 'sk-openai' };
const ticket = { id: 'T1', title: 'T1', scope: ['packages/fleet/**'], body: 'do', edges: [] };

test('live-deps dispatches via the CONFIGURED adapter (codex), not claude (AC4)', async () => {
  const rec = [];
  const deps = buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { adapter: 'codex', gate: { test: 'true' }, prosecuteFailOn: 'medium', modelAuthKey: 'ANTHROPIC_API_KEY', timeoutMinutes: 1 },
    io: fakeIo(rec, env),
  });
  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  const codexCall = rec.find((s) => s.cmd === 'codex');
  assert.ok(codexCall, 'dispatched via the codex worker');
  assert.ok(!rec.some((s) => s.cmd === 'claude'), 'did NOT dispatch claude');
  assert.equal(codexCall.args[0], 'exec');
  assert.match(codexCall.args[1], /T1/, 'the builder prompt (mentioning the ticket) is passed');
  // Model-plane env: ADLC vars + own provider auth retained, unrelated secret stripped.
  assert.equal(codexCall.env.ADLC_P4_ENFORCEMENT, '1');
  assert.equal(codexCall.env.ADLC_TICKET, 'T1');
  assert.equal(codexCall.env.ANTHROPIC_API_KEY, 'sk-anthropic');
  assert.equal(codexCall.env.OPENAI_API_KEY, undefined);
});

test('live-deps default adapter is claude-code (backward compatible) (AC5)', async () => {
  const rec = [];
  const deps = buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { gate: { test: 'true' }, prosecuteFailOn: 'medium', modelAuthKey: 'ANTHROPIC_API_KEY', timeoutMinutes: 1 }, // no adapter
    io: fakeIo(rec, env),
  });
  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  assert.ok(rec.some((s) => s.cmd === 'claude'), 'defaults to claude-code');
});

test('an unknown fleet.adapter fails closed at buildLiveDeps (AC4)', () => {
  assert.throws(
    () => buildLiveDeps({ repo: '/repo', config: { adapter: 'bogus', gate: { test: 'true' } }, sandboxSpec: { mode: 'sandbox', backend: {} }, io: fakeIo([], env) }),
    /unknown fleet worker adapter: "bogus"/,
  );
});
