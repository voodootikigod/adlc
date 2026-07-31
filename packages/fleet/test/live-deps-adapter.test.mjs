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

// ---- §8a routing provenance on the dispatch usage carrier ----

const SEAT_TICKET = { id: 'T900', title: 'T900', scope: ['packages/x/**'], body: 'do', edges: [] };

function depsWithSeat(adlcCalls, seatEntry) {
  return buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { adapter: 'opencode', gate: { test: 'true' }, prosecuteFailOn: 'medium', timeoutMinutes: 1 },
    seats: new Map([['T900', seatEntry]]),
    io: ioCapturingAdlc(adlcCalls),
  });
}

const REPORTED = { exitCode: 0, output: 'ok', usage: { inputTokens: 900, outputTokens: 150, cachedTokens: 40 }, usageStatus: 'reported' };

test('the dispatch usage carrier records the seat model, provider, tier, channel and transport', () => {
  // Counters alone cannot be priced or filtered: two channels can run the SAME
  // model over different transports (subscription vs metered API), and an
  // operator auditing overflow has to tell them apart. Only the seat knows.
  const adlcCalls = [];
  depsWithSeat(adlcCalls, {
    route: { channel: 'frontier-metered' },
    seat: { adapter: 'opencode', model: 'operator/frontier-model', provider: 'anthropic', transport: 'api:anthropic-batch' },
    assignment: { tier: 'frontier' },
  }).recordDispatchUsage({ ticket: SEAT_TICKET, result: REPORTED });

  const call = adlcCalls.find((a) => a[0] === 'gate-manifest');
  const data = JSON.parse(call[call.indexOf('--data') + 1]);
  assert.equal(data.usage.model, 'operator/frontier-model');
  assert.equal(data.usage.provider, 'anthropic');
  assert.equal(data.usage.tier, 'frontier');
  assert.equal(data.channel, 'frontier-metered');
  assert.equal(data.transport, 'api:anthropic-batch');
  // Counters survive the enrichment untouched.
  assert.equal(data.usage.inputTokens, 900);
  assert.equal(data.usage.outputTokens, 150);
  assert.equal(data.usage.cachedTokens, 40);
});

test('two channels running the SAME model over different transports stay distinguishable', () => {
  const seatFor = (channel, transport) => ({
    route: { channel },
    seat: { adapter: 'opencode', model: 'same/model', provider: 'anthropic', transport },
    assignment: { tier: 'frontier' },
  });
  const read = (seatEntry) => {
    const calls = [];
    depsWithSeat(calls, seatEntry).recordDispatchUsage({ ticket: SEAT_TICKET, result: REPORTED });
    const c = calls.find((a) => a[0] === 'gate-manifest');
    return JSON.parse(c[c.indexOf('--data') + 1]);
  };
  const sub = read(seatFor('frontier', 'subscription:anthropic-max'));
  const api = read(seatFor('frontier-metered', 'api:anthropic-batch'));
  assert.notDeepEqual(sub, api, 'metered overflow must be separable from subscription traffic');
  assert.equal(sub.transport, 'subscription:anthropic-max');
  assert.equal(api.transport, 'api:anthropic-batch');
});


test('an unreported dispatch records status only — no usage, no invented provenance', () => {
  const adlcCalls = [];
  depsWithSeat(adlcCalls, {
    route: { channel: 'mid' },
    seat: { adapter: 'opencode', model: 'zai/glm-5.2', provider: 'zai', transport: 'gateway:opencode-go' },
    assignment: { tier: 'mid' },
  }).recordDispatchUsage({ ticket: SEAT_TICKET, result: { exitCode: 0, output: 'x', usageStatus: 'unreported' } });

  const call = adlcCalls.find((a) => a[0] === 'gate-manifest');
  const data = JSON.parse(call[call.indexOf('--data') + 1]);
  assert.equal(data.usageStatus, 'unreported');
  assert.equal('usage' in data, false, 'no counters to label, so no labels');
});

test('a legacy (seatless) dispatch still records its counters', () => {
  const adlcCalls = [];
  buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { adapter: 'codex', gate: { test: 'true' }, prosecuteFailOn: 'medium', timeoutMinutes: 1 },
    io: ioCapturingAdlc(adlcCalls),
  }).recordDispatchUsage({ ticket, result: REPORTED });

  const call = adlcCalls.find((a) => a[0] === 'gate-manifest');
  const data = JSON.parse(call[call.indexOf('--data') + 1]);
  assert.equal(data.usage.inputTokens, 900);
  assert.equal('channel' in data, false, 'no seat means no routing claim');
});

test('the usage carrier binds the charge to the registry bytes in force at dispatch', () => {
  // The operator registry is MUTABLE. channel/transport labels alone cannot
  // prove which registry version chose them, so an operator who edits a channel
  // between runs leaves two plausible entries an auditor cannot tell apart.
  const adlcCalls = [];
  depsWithSeat(adlcCalls, {
    route: { channel: 'mid' },
    seat: { adapter: 'opencode', model: 'zai/glm-5.2', provider: 'zai', transport: 'gateway:opencode-go' },
    assignment: { tier: 'mid' },
    registryDigest: 'sha256:deadbeef',
  }).recordDispatchUsage({ ticket: SEAT_TICKET, result: REPORTED });

  const call = adlcCalls.find((a) => a[0] === 'gate-manifest');
  const data = JSON.parse(call[call.indexOf('--data') + 1]);
  assert.equal(data.registryDigest, 'sha256:deadbeef');
});

test('registryDigest is omitted, never fabricated, when the seat has none', () => {
  // §8a: record when supplied, omit cleanly otherwise. A placeholder would be a
  // fabricated provenance claim — the failure the no-fabrication rule forbids.
  const adlcCalls = [];
  depsWithSeat(adlcCalls, {
    route: { channel: 'mid' },
    seat: { adapter: 'opencode', model: 'zai/glm-5.2', provider: 'zai', transport: 'gateway:opencode-go' },
    assignment: { tier: 'mid' },
  }).recordDispatchUsage({ ticket: SEAT_TICKET, result: REPORTED });

  const call = adlcCalls.find((a) => a[0] === 'gate-manifest');
  assert.equal('registryDigest' in JSON.parse(call[call.indexOf('--data') + 1]), false);
});

test('a commit failure after a successful call PRESERVES the parsed usage', async () => {
  // The model call already happened and its usage was already parsed. Rebuilding
  // the result as a fresh three-field object dropped usage/usageStatus/usageRaw,
  // so a worker that succeeded but produced nothing committable — a routine
  // outcome — had its real spend recorded as 'unreported'.
  const rec = [];
  const io = fakeIo(rec, env);
  io.spawnWorker = async (cmd, args, opts) => {
    rec.push({ cmd, args, env: opts?.env });
    // A real captured payload on stdout, so usage is genuinely parsed.
    return { status: 0, stdout: '{"type":"result","result":"ok","usage":{"input_tokens":10,"output_tokens":54,"cache_read_input_tokens":5,"cache_creation_input_tokens":5}}', stderr: '' };
  };
  // The routine way to reach this path: the worker succeeded but produced
  // nothing committable, so the commit errors.
  io.git = () => (...args) => {
    if (args[0] === 'commit') throw new Error('nothing to commit, working tree clean');
    if (args[0] === 'rev-parse') return 'SHA';
    return '';
  };
  const deps = buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { adapter: 'claude-code', gate: { test: 'true' }, prosecuteFailOn: 'medium', timeoutMinutes: 1 },
    io,
  });

  const res = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });

  // The commit fails in this stubbed world (no real git), which is the path
  // under test: the dispatch reports failure but MUST keep its telemetry.
  assert.equal(res.exitCode, 1, 'precondition: this run took the commit-failure path');
  assert.equal(res.usageStatus, 'reported', 'the call happened, so its spend must survive the orchestration failure');
  assert.equal(res.usage.inputTokens, 10);
  assert.equal(res.usage.outputTokens, 54);
});

// ---- a recorder failure must be loud, never silent ----

function captureStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.error = original; }
  return lines.join('\n');
}

function depsWithRecorder(adlcImpl) {
  const io = fakeIo([], env);
  io.adlc = adlcImpl;
  return buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { adapter: 'codex', gate: { test: 'true' }, prosecuteFailOn: 'medium', timeoutMinutes: 1 },
    io,
  });
}

// io.adlc is spawnSync-shaped: an ordinary CLI failure returns a nonzero status
// and NEVER throws, so a bare try/catch reports it as success. Each of these is
// a real way the recorder fails in production.
const RECORDER_FAILURES = {
  'nonzero exit (invalid chain, signing error)': () => ({ status: 1, stdout: '', stderr: 'manifest chain broken' }),
  'spawn error (binary missing)': () => ({ error: new Error('spawn adlc ENOENT') }),
  'killed by signal': () => ({ status: null, signal: 'SIGKILL' }),
  'no exit status at all': () => ({}),
  'a thrown failure': () => { throw new Error('ledger unavailable'); },
};

for (const [label, impl] of Object.entries(RECORDER_FAILURES)) {
  test(`a recorder failure is reported, not swallowed — ${label}`, () => {
    const deps = depsWithRecorder(impl);
    const stderr = captureStderr(() => {
      deps.recordDispatchUsage({ ticket, result: { exitCode: 0, output: 'ok', usage: { inputTokens: 900, outputTokens: 150, cachedTokens: 0 }, usageStatus: 'reported' } });
    });
    assert.match(stderr, /was NOT recorded/, `${label}: the operator must be told`);
    assert.match(stderr, /MISSING from the ledger, not zero/, `${label}: and told what it means`);
  });

  test(`a recorder failure never aborts the build — ${label}`, () => {
    const deps = depsWithRecorder(impl);
    assert.doesNotThrow(() => captureStderr(() => {
      deps.recordDispatchUsage({ ticket, result: { exitCode: 0, output: 'ok', usageStatus: 'unreported' } });
    }));
  });
}

test('a SUCCESSFUL record says nothing', () => {
  const deps = depsWithRecorder(() => ({ status: 0, stdout: '{}', stderr: '' }));
  const stderr = captureStderr(() => {
    deps.recordDispatchUsage({ ticket, result: { exitCode: 0, output: 'ok', usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, usageStatus: 'reported' } });
  });
  assert.equal(stderr, '', 'a working recorder must not cry wolf');
});

test('a commit failure is reported as a FAILURE, not as a timeout', async () => {
  // `timedOut` drives how the failure is classified downstream. Labelling a
  // commit failure as a harness timeout sends an operator hunting a hung model
  // call that never happened, and misreports the strike's cause.
  const rec = [];
  const io = fakeIo(rec, env);
  io.spawnWorker = async () => ({ status: 0, stdout: '{"type":"result","result":"ok","usage":{"input_tokens":10,"output_tokens":54,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}', stderr: '' });
  io.git = () => (...args) => {
    if (args[0] === 'commit') throw new Error('nothing to commit, working tree clean');
    if (args[0] === 'rev-parse') return 'SHA';
    return '';
  };
  const deps = buildLiveDeps({
    repo: '/repo', statusDir: undefined, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { adapter: 'claude-code', gate: { test: 'true' }, prosecuteFailOn: 'medium', timeoutMinutes: 1 },
    io,
  });

  const res = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  assert.equal(res.exitCode, 1, 'precondition: the commit-failure path');
  assert.equal(res.timedOut, false, 'a commit failure is not a timeout');
  assert.match(res.output, /commit failed/);
});
