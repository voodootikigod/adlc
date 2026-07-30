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
    appendLog: () => {},
    adlcAsync: async () => ({ status: 0, stdout: '' }),
    spawnWorker: async (cmd, args, opts) => { rec.push({ cmd, args, env: opts?.env, input: opts?.input }); return { status: 0, stdout: 'TICKET-DONE', stderr: '' }; },
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

test('deps.provision does not throw for ANY registered adapter (A1)', async () => {
  const { ADAPTERS } = await import('../lib/adapters/index.mjs');
  for (const adapterName of ADAPTERS) {
    const deps = buildLiveDeps({
      repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
      reviewRunner: () => ({ ok: true, findings: [] }),
      config: { adapter: adapterName, gate: { test: 'true' }, prosecuteFailOn: 'medium', modelAuthKey: 'ANTHROPIC_API_KEY' },
      io: fakeIo([], env),
    });
    await deps.provision({ ticket, worktree: '/wt/T1' }); // must not throw (adapters without provision no-op)
  }
});

test('config.adapterStdin threads to the pi adapter (useStdin → prompt on stdin) (A3)', async () => {
  const rec = [];
  const deps = buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { adapter: 'pi', adapterStdin: true, adapterArgs: ['--mode', 'rpc'], gate: { test: 'true' }, prosecuteFailOn: 'medium', modelAuthKey: 'ANTHROPIC_API_KEY' },
    io: fakeIo(rec, env),
  });
  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  const piCall = rec.find((s) => s.cmd === 'pi');
  assert.ok(piCall, 'dispatched via pi');
  assert.deepEqual(piCall.args, ['--mode', 'rpc'], 'operator-local adapterArgs used');
  assert.ok(piCall.input && piCall.input.length > 0, 'adapterStdin routed the prompt to the pi stdin (A3)');
});

test('an unknown fleet.adapter fails closed at buildLiveDeps (AC4)', () => {
  assert.throws(
    () => buildLiveDeps({ repo: '/repo', config: { adapter: 'bogus', gate: { test: 'true' } }, sandboxSpec: { mode: 'sandbox', backend: {} }, io: fakeIo([], env) }),
    /unknown fleet worker adapter: "bogus"/,
  );
});

// The seats-present branch of buildLiveDeps had NO coverage — a surviving
// mutant on `seats.size > 0` proved it, because every existing test passes
// `seats: undefined`, where the ternary short-circuits and the comparison is
// never evaluated. These two tests exercise the branch itself.

const seatMap = (adapter, model) =>
  new Map([['T1', { seat: { adapter, model, transport: 'gateway:opencode-go', provider: 'zai' } }]]);

test('an engaged registry supersedes --adapter entirely, including a stale one', async () => {
  const rec = [];
  // `--adapter no-such-harness` would abort assembly on the legacy path (AC4).
  // With seats present it is never consulted, so assembly must succeed and
  // dispatch must use the SEAT's adapter — otherwise the dry-run (which previews
  // only seat adapters) would disagree with the live run.
  const deps = buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    config: { adapter: 'no-such-harness', gate: { test: 'true' } },
    seats: seatMap('opencode', 'zai/glm-5.2'),
    io: fakeIo(rec, env),
  });
  await deps.dispatch({ ticket, worktree: '/wt/T1', strike: 1 });
  assert.equal(rec[0].cmd, 'opencode', 'the seat adapter runs, not the stale --adapter');
  assert.ok(rec[0].args.includes('-m') && rec[0].args.includes('zai/glm-5.2'), 'the seat model is forced');
});

test('a ticket with no seat refuses to dispatch rather than falling back to --adapter', async () => {
  const rec = [];
  const deps = buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    config: { adapter: 'codex', gate: { test: 'true' } },
    seats: seatMap('opencode', 'zai/glm-5.2'), // covers T1 only
    io: fakeIo(rec, env),
  });
  await assert.rejects(
    () => deps.dispatch({ ticket: { ...ticket, id: 'T-UNROUTED' }, worktree: '/wt/x', strike: 1 }),
    /no quartermaster seat/,
    'an unrouted ticket must not run on supply the registry never authorized'
  );
  assert.equal(rec.length, 0, 'nothing was spawned');
});

// ---- T152 §8a: usage evidence reaches the gate-manifest recorder ----

function ioCapturingAdlc(adlcCalls) {
  const rec = [];
  const io = fakeIo(rec, env);
  io.adlc = (args) => { adlcCalls.push(args); return { status: 0, stdout: '{}' }; };
  return io;
}

function depsForRecord(adlcCalls) {
  return buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { adapter: 'codex', gate: { test: 'true' }, prosecuteFailOn: 'medium', timeoutMinutes: 1 },
    io: ioCapturingAdlc(adlcCalls),
  });
}

test('recordGate passes usage evidence through as --data', () => {
  const adlcCalls = [];
  const data = { usageStatus: 'reported', usage: { inputTokens: 900, outputTokens: 150, cachedTokens: 40 } };
  depsForRecord(adlcCalls).recordGate({ ticket, phase: 'p4', ok: true, data });

  const call = adlcCalls.find((a) => a[0] === 'gate-manifest');
  assert.ok(call, 'the recorder was invoked');
  const i = call.indexOf('--data');
  assert.notEqual(i, -1, '--data must be present when there is usage to record');
  assert.deepEqual(JSON.parse(call[i + 1]), data, 'the payload reaches the ledger verbatim');
  assert.deepEqual(call.slice(0, 5), ['gate-manifest', 'record', 'p4', '--ticket', 'T1']);
  assert.ok(call.includes('--pass'));
});

test('recordGate emits the SAME argv as before when there is nothing to record', () => {
  // A pure addition to the evidence: a recorder with no usage must not start
  // writing a new field, or every pre-T152 caller's entries change shape.
  const adlcCalls = [];
  depsForRecord(adlcCalls).recordGate({ ticket, phase: 'p5', ok: false });

  const call = adlcCalls.find((a) => a[0] === 'gate-manifest');
  assert.deepEqual(call, ['gate-manifest', 'record', 'p5', '--ticket', 'T1', '--fail']);
  assert.equal(call.includes('--data'), false);
});

test('a recorder failure never escapes — evidence stays best-effort (AC5)', () => {
  const deps = buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { adapter: 'codex', gate: { test: 'true' }, prosecuteFailOn: 'medium', timeoutMinutes: 1 },
    io: (() => { const io = fakeIo([], env); io.adlc = () => { throw new Error('ledger unavailable'); }; return io; })(),
  });
  assert.doesNotThrow(() => deps.recordGate({ ticket, phase: 'p4', ok: true, data: { usageStatus: 'unreported' } }));
});
