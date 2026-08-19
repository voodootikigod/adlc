// F8 ladder escalation at the DISPATCH seam (issue #401).
//
// The claim under test is about what actually runs, so every assertion here is
// on the argv the adapter rendered into the recorded spawn call — never on a
// plan object or a seat lookup. A seat map is built by the REAL `planSeats`
// (real registry bytes, real computeFloat, real assignAll, real routeJob), so a
// hand-written escalation array cannot make these pass.

import { test } from 'node:test';
import { unwrap } from './helpers/worker-calls.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildLiveDeps } from '../lib/live-deps.mjs';
import { planSeats } from '../lib/quartermaster.mjs';
import { runFleet } from '../lib/run.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Each rung is a DIFFERENT harness where it matters, so "which rung ran" is
// visible in the spawned command itself and not only in a model flag.
//
//   cheap    → opencode    deepseek/v4-flash
//   mid      → opencode    zai/glm-5.2
//   frontier → claude-code claude-opus-5
const REGISTRY = {
  version: 3,
  channels: {
    frontier: { adapter: 'claude-code', model: 'claude-opus-5', transport: 'subscription:anthropic-max', provider: 'anthropic' },
    'frontier-metered': { adapter: 'claude-code', model: 'claude-opus-5', transport: 'api:anthropic-batch', provider: 'anthropic' },
    mid: { adapter: 'opencode', model: 'zai/glm-5.2', transport: 'gateway:opencode-go', provider: 'zai' },
    cheap: { adapter: 'opencode', model: 'deepseek/v4-flash', transport: 'gateway:opencode-go', provider: 'deepseek' },
  },
  reviewerGroups: {
    'cross-model-routine': {
      quorum: 1,
      members: [{ adapter: 'opencode', model: 'qwen/qwen3.7-coder', transport: 'gateway:opencode-go', provider: 'alibaba' }],
    },
    'cross-model-trust-root': {
      quorum: 2,
      members: [
        { adapter: 'opencode', model: 'moonshot/kimi-k3', transport: 'gateway:opencode-go', provider: 'moonshot' },
        { adapter: 'codex', model: 'gpt-5.3-codex', transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
      ],
    },
  },
  modelProviders: {
    opencode: {
      'zai/glm-5.2': 'zai',
      'deepseek/v4-flash': 'deepseek',
      'qwen/qwen3.7-coder': 'alibaba',
      'moonshot/kimi-k3': 'moonshot',
    },
    'claude-code': { 'claude-opus-5': 'anthropic' },
    codex: { 'gpt-5.3-codex': 'openai' },
  },
};

// A DAG that produces every case in one routing pass. Float: T-CRIT and T-SINK
// are on the critical path (0); T-CHEAP and T-FLOOR carry slack (2).
//
//   T-CRIT(3)  ─┐
//   T-CHEAP(1) ─┼─→ T-SINK(2)
//   T-FLOOR(1) ─┘
const TICKETS = [
  {
    id: 'T-CRIT', title: 'critical path', category: 'feature', duration: 3, body: 'x',
    edges: [{ to: 'T-SINK' }], rails: ['a/r.mjs'], scope: ['a/**', 'b/**'],
  },
  {
    // density 1/2 = 0.5 → ladder starting on `cheap`, mode 'ladder'.
    id: 'T-CHEAP', title: 'slack, dense rails', category: 'feature', duration: 1, body: 'x',
    edges: [{ to: 'T-SINK' }], rails: ['a/r.mjs'], scope: ['a/**', 'b/**'],
  },
  {
    // NO rails → density 0 < floor → assign.mjs returns {tier:'frontier', mode:'direct'}
    // while routeJob still DERIVES build.ladder-start from the non-zero float.
    // This is the case that proves escalation keys on MODE, not on the job alone.
    id: 'T-FLOOR', title: 'slack, no rails', category: 'feature', duration: 1, body: 'x',
    edges: [{ to: 'T-SINK' }], scope: ['c/**', 'd/**'],
  },
  { id: 'T-SINK', title: 'integration', category: 'feature', duration: 2, body: 'x', edges: [], rails: ['a/r.mjs'], scope: ['a/**', 'b/**'] },
];

const byId = (id) => TICKETS.find((t) => t.id === id);

/** Real planSeats over real registry bytes — nothing about the ladder is hand-written. */
function realSeats() {
  const adlcDir = mkdtempSync(join(tmpdir(), 'ladder-adlc-'));
  mkdirSync(adlcDir, { recursive: true });
  try {
    return planSeats({
      tickets: TICKETS,
      repoDir: '/repo',
      env: { ADLC_QUARTERMASTER_REGISTRY: '/operator/quartermaster.json' },
      adlcDir,
      exists: (p) => p === '/operator/quartermaster.json',
      readFile: (p) => {
        if (p !== '/operator/quartermaster.json') throw new Error(`unexpected read: ${p}`);
        return JSON.stringify(REGISTRY);
      },
    }).seats;
  } finally {
    rmSync(adlcDir, { recursive: true, force: true });
  }
}

const ENV = { PATH: '/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-a' };

function fakeIo(rec, extra = {}) {
  return {
    git: () => () => '',
    adlc: () => ({ status: 0, stdout: '{}' }),
    adlcAsync: async () => ({ status: 0, stdout: '' }),
    appendLog: () => {},
    spawnWorker: async (cmd, args, opts) => {
      // These tests are about which SEAT ran, not about containment, so they record
      // the inner argv. Since #395 the model plane is sandbox-wrapped, and the
      // harness the registry chose is what the wrapper wraps.
      rec.push(unwrap({ cmd, args, env: opts?.env }));
      return { status: 0, stdout: JSON.stringify({ type: 'result', result: 'TICKET-DONE' }), stderr: '' };
    },
    readFile: () => undefined,
    exists: () => false,
    mkdirp: () => {},
    writeJson: () => {},
    ensureGitignore: () => {},
    env: ENV,
    hasGh: () => false,
    ...extra,
  };
}

function depsFor(rec, ioExtra = {}) {
  return buildLiveDeps({
    repo: '/repo',
    statusDir: undefined,
    sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { gate: { test: 'true' }, prosecuteFailOn: 'medium', modelAuthKey: 'ANTHROPIC_API_KEY', timeoutMinutes: 1 },
    seats: realSeats(),
    io: fakeIo(rec, ioExtra),
  });
}

// ---------------------------------------------------------------------------
// The fixture routes the way the test assumes — asserted, not believed
// ---------------------------------------------------------------------------

test('the fixture DAG really produces a cheap ladder, a direct critical path, and a below-floor direct', () => {
  const seats = realSeats();
  const cheap = seats.get('T-CHEAP');
  assert.equal(cheap.job, 'build.ladder-start');
  assert.equal(cheap.assignment.mode, 'ladder');
  assert.equal(cheap.route.channel, 'cheap');

  const crit = seats.get('T-CRIT');
  assert.equal(crit.job, 'build.critical-path');
  assert.equal(crit.assignment.mode, 'direct');
  assert.equal(crit.route.channel, 'frontier');

  const floor = seats.get('T-FLOOR');
  assert.equal(floor.job, 'build.ladder-start', 'derived from non-zero float');
  assert.equal(floor.assignment.mode, 'direct', 'but the router refused to start a ladder');
});

// ---------------------------------------------------------------------------
// AC1 — a ladder ticket climbs, asserted on the rendered argv
// ---------------------------------------------------------------------------

test('strike 2 of a ladder ticket dispatches on the NEXT channel up — asserted on the argv that ran', async () => {
  const rec = [];
  const deps = depsFor(rec);
  const ticket = byId('T-CHEAP');

  await deps.dispatch({ ticket, worktree: '/wt/T-CHEAP', startSha: 'SHA', strike: 1, deadEnds: [] });
  assert.equal(rec.length, 1);
  assert.equal(rec[0].cmd, 'opencode', 'strike 1 runs the cheap seat harness');
  assert.ok(rec[0].args.includes('deepseek/v4-flash'), `strike 1 forces the cheap model: ${JSON.stringify(rec[0].args)}`);

  await deps.dispatch({ ticket, worktree: '/wt/T-CHEAP', startSha: 'SHA', strike: 2, deadEnds: ['BUILD failed'] });
  assert.equal(rec.length, 2);
  assert.ok(rec[1].args.includes('zai/glm-5.2'), `strike 2 forces the MID model: ${JSON.stringify(rec[1].args)}`);
  assert.ok(!rec[1].args.includes('deepseek/v4-flash'), 'strike 2 did not re-run the cheap model');
});

test('a third attempt climbs to frontier — a different HARNESS, not merely a different model', async () => {
  const rec = [];
  const deps = depsFor(rec);
  await deps.dispatch({ ticket: byId('T-CHEAP'), worktree: '/wt/T-CHEAP', startSha: 'SHA', strike: 3, deadEnds: [] });
  assert.equal(rec[0].cmd, 'claude', 'the frontier seat names a different adapter');
  assert.ok(rec[0].args.includes('claude-opus-5'), `the frontier model is forced: ${JSON.stringify(rec[0].args)}`);
});

test('escalation stops at the top rung instead of running off the end', async () => {
  const rec = [];
  const deps = depsFor(rec);
  // maxStrikes is 2 today; this proves a future bump cannot index past the
  // ladder and hand dispatch an undefined seat.
  for (const strike of [4, 5, 9]) {
    await deps.dispatch({ ticket: byId('T-CHEAP'), worktree: '/wt/T-CHEAP', startSha: 'SHA', strike, deadEnds: [] });
  }
  assert.equal(rec.length, 3);
  for (const call of rec) {
    assert.equal(call.cmd, 'claude');
    assert.ok(call.args.includes('claude-opus-5'));
  }
});

// ---------------------------------------------------------------------------
// AC2 — direct mode does not escalate
// ---------------------------------------------------------------------------

/**
 * The seat a spawn actually used: its harness plus the model it was forced to.
 *
 * Strike 2 legitimately carries a DIFFERENT prompt (the fix charter), so
 * comparing whole argvs would report a difference on every retry and could
 * never distinguish "same seat" from "escalated". The model flag is read out of
 * the rendered argv rather than from the seat map, so this still asserts on
 * what the adapter put on the command line.
 */
function seatOf(call) {
  const flag = call.args.findIndex((a) => a === '-m' || a === '--model');
  return { cmd: call.cmd, model: flag === -1 ? null : call.args[flag + 1] };
}

test('a direct-mode ticket re-dispatches strike 2 on the SAME seat', async () => {
  const rec = [];
  const deps = depsFor(rec);
  const ticket = byId('T-CRIT');
  await deps.dispatch({ ticket, worktree: '/wt/T-CRIT', startSha: 'SHA', strike: 1, deadEnds: [] });
  await deps.dispatch({ ticket, worktree: '/wt/T-CRIT', startSha: 'SHA', strike: 2, deadEnds: ['BUILD failed'] });
  assert.equal(rec.length, 2);
  assert.deepEqual(seatOf(rec[1]), seatOf(rec[0]), 'the critical-path seat is identical on both strikes');
  assert.equal(rec[1].cmd, 'claude');
  assert.ok(rec[1].args.includes('claude-opus-5'));
});

test('a below-floor ticket derives build.ladder-start but does NOT climb — mode decides, not the job', async () => {
  const rec = [];
  const deps = depsFor(rec);
  const ticket = byId('T-FLOOR');
  await deps.dispatch({ ticket, worktree: '/wt/T-FLOOR', startSha: 'SHA', strike: 1, deadEnds: [] });
  await deps.dispatch({ ticket, worktree: '/wt/T-FLOOR', startSha: 'SHA', strike: 2, deadEnds: ['BUILD failed'] });
  assert.deepEqual(seatOf(rec[1]), seatOf(rec[0]), 'the router routed it direct; escalation must not override that');
});

// ---------------------------------------------------------------------------
// AC4 — the ledger records the channel that RAN
// ---------------------------------------------------------------------------

function recordedData(adlcCalls) {
  return adlcCalls.map((argv) => JSON.parse(argv[argv.indexOf('--data') + 1]));
}

test('the §8a dispatch carrier records the escalated channel and where it escalated FROM', () => {
  const adlcCalls = [];
  const deps = depsFor([], { adlc: (argv) => { adlcCalls.push(argv); return { status: 0, stdout: '{}' }; } });
  const ticket = byId('T-CHEAP');
  const result = { exitCode: 0, output: 'ok', usageStatus: 'unreported' };

  deps.recordDispatchUsage({ ticket, result, strike: 1 });
  deps.recordDispatchUsage({ ticket, result, strike: 2 });

  const [first, second] = recordedData(adlcCalls);
  assert.equal(first.channel, 'cheap');
  assert.equal('escalatedFrom' in first, false, 'a non-escalated dispatch carries no escalatedFrom key');
  assert.equal(second.channel, 'mid', 'the carrier names the channel that actually ran');
  assert.equal(second.escalatedFrom, 'cheap');
});

test('the carrier follows the escalated seat transport too, not the starting one', () => {
  const adlcCalls = [];
  const deps = depsFor([], { adlc: (argv) => { adlcCalls.push(argv); return { status: 0, stdout: '{}' }; } });
  const result = { exitCode: 0, output: 'ok', usageStatus: 'unreported' };
  deps.recordDispatchUsage({ ticket: byId('T-CHEAP'), result, strike: 3 });
  const [data] = recordedData(adlcCalls);
  assert.equal(data.channel, 'frontier');
  assert.equal(data.transport, 'subscription:anthropic-max', 'the frontier seat transport, not the cheap gateway');
});

test('a direct-mode carrier is unchanged by escalation support', () => {
  const adlcCalls = [];
  const deps = depsFor([], { adlc: (argv) => { adlcCalls.push(argv); return { status: 0, stdout: '{}' }; } });
  const result = { exitCode: 0, output: 'ok', usageStatus: 'unreported' };
  deps.recordDispatchUsage({ ticket: byId('T-CRIT'), result, strike: 2 });
  const [data] = recordedData(adlcCalls);
  assert.equal(data.channel, 'frontier');
  assert.equal('escalatedFrom' in data, false);
});

test('the recorded usage provenance follows the seat that ran', () => {
  const adlcCalls = [];
  const deps = depsFor([], { adlc: (argv) => { adlcCalls.push(argv); return { status: 0, stdout: '{}' }; } });
  const result = {
    exitCode: 0, output: 'ok', usageStatus: 'reported',
    usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 0 },
  };
  deps.recordDispatchUsage({ ticket: byId('T-CHEAP'), result, strike: 2 });
  const [data] = recordedData(adlcCalls);
  assert.equal(data.usage.model, 'zai/glm-5.2', 'the escalated model is what spent the tokens');
  assert.equal(data.usage.provider, 'zai');
  assert.equal(data.usage.inputTokens, 10, 'counters are passed through untouched');
});

// ---------------------------------------------------------------------------
// AC5 — every rung is provisioned
// ---------------------------------------------------------------------------

test('provision covers every DISTINCT adapter on the ladder, so an escalated strike is never unprovisioned', async () => {
  const written = [];
  const deps = depsFor([], { writeJson: (path, obj) => written.push({ path, obj }) });
  await deps.provision({ ticket: byId('T-CHEAP'), worktree: '/wt/T-CHEAP' });
  // cheap and mid are both opencode (no provision hook); frontier is claude-code,
  // which writes the worktree allowlist its worker needs to run at all.
  assert.equal(written.length, 1, `expected exactly one settings write, got ${JSON.stringify(written)}`);
  assert.match(written[0].path, /\.claude[/\\]settings\.local\.json$/);
});

test('a ticket whose ladder never leaves one adapter provisions it once, not once per rung', async () => {
  const written = [];
  const deps = depsFor([], { writeJson: (path) => written.push(path) });
  // T-CRIT is direct on frontier → claude-code only.
  await deps.provision({ ticket: byId('T-CRIT'), worktree: '/wt/T-CRIT' });
  assert.equal(written.length, 1);
});

// ---------------------------------------------------------------------------
// The strike reaches the recorder through the REAL run wiring
// ---------------------------------------------------------------------------

test('an unusable strike number costs the entry its PROVENANCE, never its counters', () => {
  // recordDispatchUsage runs inside a best-effort try/catch, so a throw here
  // would discard the whole carrier and lose a real call's spend in silence —
  // the same "unknown silently becoming zero" this recorder already warns
  // about for CLI failures. The counters must survive; only the channel goes.
  const adlcCalls = [];
  const errors = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    const deps = depsFor([], { adlc: (argv) => { adlcCalls.push(argv); return { status: 0, stdout: '{}' }; } });
    deps.recordDispatchUsage({
      ticket: byId('T-CHEAP'),
      result: { exitCode: 0, output: 'ok', usageStatus: 'reported', usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 0 } },
      strike: 0, // not a valid attempt number
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(adlcCalls.length, 1, 'the spend is still recorded');
  const [data] = recordedData(adlcCalls);
  assert.equal(data.usage.inputTokens, 7, 'the counters are untouched');
  assert.equal('channel' in data, false, 'no channel is asserted when the attempt is unknown');
  assert.equal('escalatedFrom' in data, false);
  assert.ok(
    errors.some((e) => e.includes('WITHOUT channel provenance')),
    `the degradation is announced, not silent: ${JSON.stringify(errors)}`,
  );
});

test('a real two-strike run tells the recorder WHICH strike each dispatch was', async () => {
  // The dispatch seam already carried `strike`; the recorder seam did not, and
  // a carrier with no attempt number silently attributes an escalated call to
  // the starting channel. This drives runFleet — scheduler → buildEffects →
  // deps.recordDispatchUsage — rather than calling the recorder directly, so
  // the wiring itself is what is under test.
  const seen = [];
  let dispatches = 0;
  const ticket = { id: 'T1', title: 'T1', scope: ['src/T1/**'], edges: [] };
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket: t }) => ({ path: `/wt/${t.id}`, branch: `fleet/${t.id}`, startSha: 'tip' }),
    // Strike 1 fails its build so the scheduler retries; strike 2 succeeds.
    dispatch: () => (++dispatches === 1 ? { exitCode: 1, output: 'boom' } : { exitCode: 0, output: 'TICKET-DONE' }),
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: () => ({ mergeSha: 'm', preMergeSha: 'p' }),
    postMergeGate: () => ({ ok: true }),
    revertMerge: () => ({ method: 'reset', ok: true }),
    recordDispatchUsage: ({ strike }) => seen.push(strike),
  };
  await runFleet({ all: [ticket], runId: 'esc', config: { concurrency: 1, base: 'main', baseSha: 'BASE' }, deps });
  assert.deepEqual(seen, [1, 2], 'each dispatch is recorded against the strike that made it');
});
