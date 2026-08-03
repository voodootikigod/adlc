// Transport is load-bearing at dispatch (issue #396).
//
// THE GUARANTEE IS ASYMMETRIC, and these tests are written around that:
// stripping a credential is PROVABLE (with no key in the environment, a
// subscription seat cannot have been metered), while supplying one is not (a
// harness handed an API key may still prefer a stored session). The negative
// direction is therefore the load-bearing one, and it gets the strongest
// assertions here.
//
// Seats come from the REAL planSeats over real registry bytes, so a
// hand-written seat object cannot make these pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildLiveDeps } from '../lib/live-deps.mjs';
import { planSeats } from '../lib/quartermaster.mjs';
import { modelPlaneEnv } from '../lib/env-scrub.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// frontier and frontier-metered differ ONLY in transport — the documented pair
// from docs/integrations/quartermaster-registry.md, and the exact shape the
// issue says breaks today.
const REGISTRY = {
  version: 3,
  channels: {
    frontier: { adapter: 'claude-code', model: 'claude-opus-5', transport: 'subscription:anthropic-max', provider: 'anthropic' },
    'frontier-metered': { adapter: 'claude-code', model: 'claude-opus-5', transport: 'api:anthropic-batch', provider: 'anthropic' },
    mid: { adapter: 'opencode', model: 'zai/glm-5.2', transport: 'gateway:opencode-go', provider: 'zai' },
    cheap: { adapter: 'opencode', model: 'deepseek/v4-flash', transport: 'gateway:opencode-go', provider: 'deepseek' },
  },
  reviewerGroups: {
    'cross-model-routine': { quorum: 1, members: [{ adapter: 'opencode', model: 'qwen/qwen3.7-coder', transport: 'gateway:opencode-go', provider: 'alibaba' }] },
    'cross-model-trust-root': {
      quorum: 2,
      members: [
        { adapter: 'opencode', model: 'moonshot/kimi-k3', transport: 'gateway:opencode-go', provider: 'moonshot' },
        { adapter: 'codex', model: 'gpt-5.3-codex', transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
      ],
    },
  },
  modelProviders: {
    opencode: { 'zai/glm-5.2': 'zai', 'deepseek/v4-flash': 'deepseek', 'qwen/qwen3.7-coder': 'alibaba', 'moonshot/kimi-k3': 'moonshot' },
    'claude-code': { 'claude-opus-5': 'anthropic' },
    codex: { 'gpt-5.3-codex': 'openai' },
  },
};

// T-SUB is critical-path → frontier (subscription). T-GW carries slack with a
// low rail density → mid (gateway). Both derived by the real router.
const TICKETS = [
  { id: 'T-SUB', title: 'critical path', category: 'feature', duration: 3, body: 'x', edges: [{ to: 'T-SINK' }], rails: ['a/r.mjs'], scope: ['a/**', 'b/**'] },
  { id: 'T-GW', title: 'slack', category: 'feature', duration: 1, body: 'x', edges: [{ to: 'T-SINK' }], rails: ['a/r.mjs'], scope: ['a/**', 'b/**', 'c/**', 'd/**'] },
  { id: 'T-SINK', title: 'integration', category: 'feature', duration: 2, body: 'x', edges: [], rails: ['a/r.mjs'], scope: ['a/**', 'b/**'] },
];

const byId = (id) => TICKETS.find((t) => t.id === id);

/** The ambient environment a real operator plausibly has: several provider keys at once. */
const AMBIENT = Object.freeze({
  PATH: '/usr/bin',
  HOME: '/home/op',
  ANTHROPIC_API_KEY: 'AMBIENT-anthropic-credential',
  OPENAI_API_KEY: 'AMBIENT-openai-credential',
  GEMINI_API_KEY: 'AMBIENT-gemini-credential',
  ADLC_MANIFEST_KEY: 'ledger-signing-key-must-never-leak',
});

function realSeats(registry = REGISTRY) {
  const adlcDir = mkdtempSync(join(tmpdir(), 'transport-adlc-'));
  mkdirSync(adlcDir, { recursive: true });
  try {
    return planSeats({
      tickets: TICKETS,
      repoDir: '/repo',
      env: { ADLC_QUARTERMASTER_REGISTRY: '/operator/quartermaster.json' },
      adlcDir,
      exists: (p) => p === '/operator/quartermaster.json',
      readFile: () => JSON.stringify(registry),
    }).seats;
  } finally {
    rmSync(adlcDir, { recursive: true, force: true });
  }
}

function fakeIo(rec, extra = {}) {
  return {
    git: () => () => '',
    adlc: () => ({ status: 0, stdout: '{}' }),
    adlcAsync: async () => ({ status: 0, stdout: '' }),
    appendLog: () => {},
    spawnWorker: async (cmd, args, opts) => {
      rec.push({ cmd, args, env: opts?.env });
      return { status: 0, stdout: JSON.stringify({ type: 'result', result: 'TICKET-DONE' }), stderr: '' };
    },
    readFile: () => undefined,
    exists: () => false,
    mkdirp: () => {},
    writeJson: () => {},
    ensureGitignore: () => {},
    env: AMBIENT,
    hasGh: () => false,
    ...extra,
  };
}

/**
 * `modelAuthKey` is set on EVERY engaged-path fixture on purpose.
 *
 * It is the realistic operator configuration — you set `fleet.modelAuthKey` for
 * the pre-registry path and it stays set — and it is what makes these tests
 * load-bearing. With it unset, `modelPlaneEnv` strips every provider key
 * anyway, so "a subscription seat carries no API key" would pass on unmodified
 * main: an assertion satisfied by pre-existing behaviour rather than by the
 * change under test. With it set, the ambient key DOES reach the worker today,
 * and only the seat's transport can take it away.
 */
function depsFor(rec, { seats = realSeats(), config = {}, ioExtra = {} } = {}) {
  return buildLiveDeps({
    repo: '/repo',
    statusDir: undefined,
    sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { gate: { test: 'true' }, prosecuteFailOn: 'medium', timeoutMinutes: 1, modelAuthKey: 'ANTHROPIC_API_KEY', ...config },
    seats,
    io: fakeIo(rec, ioExtra),
  });
}

async function dispatchEnv(ticketId, opts = {}) {
  const rec = [];
  const deps = depsFor(rec, opts);
  await deps.dispatch({ ticket: byId(ticketId), worktree: `/wt/${ticketId}`, startSha: 'SHA', strike: 1, deadEnds: [] });
  assert.equal(rec.length, 1, 'exactly one dispatch was spawned');
  return rec[0].env;
}

// ---------------------------------------------------------------------------
// The fixture routes the way these tests assume
// ---------------------------------------------------------------------------

test('the fixture really produces a subscription seat and a gateway seat', () => {
  const seats = realSeats();
  assert.equal(seats.get('T-SUB').seat.transport, 'subscription:anthropic-max');
  assert.equal(seats.get('T-GW').seat.transport, 'gateway:opencode-go');
});

// ---------------------------------------------------------------------------
// THE COST LEAK — the load-bearing guarantee
// ---------------------------------------------------------------------------

test('a subscription seat carries NO provider API key, so it cannot have been metered', async () => {
  // This is the whole point of #396 for a subscriptions-first operator: the
  // ambient environment has three provider keys AND the operator has configured
  // fleet.modelAuthKey=ANTHROPIC_API_KEY, so today that key reaches the worker
  // and the harness may bill metered rates against a seat whose entire purpose
  // was to consume a subscription already paid for. The seat's transport must
  // take it away — leaving the session as the only way in.
  const env = await dispatchEnv('T-SUB');
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'the ambient Anthropic key must NOT reach a subscription seat');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.HOME, '/home/op', 'HOME is untouched — the session lives there (premortem finding 2)');
});

test('an api seat receives exactly its declared credential, and the subscription seat does not', async () => {
  // frontier and frontier-metered differ ONLY in transport. Asserted in BOTH
  // directions so a change that hands every seat the key still fails.
  const seats = realSeats();
  // Route T-SUB through the metered seat by SWAPPING the pair at the registry
  // level, not by hand-building a seat — and a swap, not a copy, because §4b
  // rule 3 rejects a registry whose frontier and frontier-metered share a
  // transport (the fallback edge exists only to change it).
  const swapped = {
    ...REGISTRY,
    channels: {
      ...REGISTRY.channels,
      frontier: REGISTRY.channels['frontier-metered'],
      'frontier-metered': REGISTRY.channels.frontier,
    },
  };
  const apiEnv = await dispatchEnv('T-SUB', { seats: realSeats(swapped) });
  const subEnv = await dispatchEnv('T-SUB', { seats });

  assert.equal(apiEnv.ANTHROPIC_API_KEY, 'AMBIENT-anthropic-credential', 'the api seat is given its declared credential');
  assert.equal(subEnv.ANTHROPIC_API_KEY, undefined, 'the subscription seat is not');
  assert.notDeepEqual(apiEnv, subEnv, 'two seats differing only by transport never dispatch identically');
});

test('a gateway seat gets no direct-provider key — its credential lives in the harness config', async () => {
  const env = await dispatchEnv('T-GW');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
});

// ---------------------------------------------------------------------------
// NEVER_EXEMPT — the ledger signing key
// ---------------------------------------------------------------------------

test('the ledger signing key never reaches a worker, whatever the transport asks for', async () => {
  for (const id of ['T-SUB', 'T-GW']) {
    const env = await dispatchEnv(id);
    assert.equal(env.ADLC_MANIFEST_KEY, undefined, `${id} must never receive the signing key`);
  }
});

test('ADLC_MANIFEST_KEY stays never-exemptable even when named directly as the credential', () => {
  // Defence in depth at the env layer itself: a worker holding this key could
  // forge the cross-model attestations the merge gate trusts, so no selection
  // mechanism — transport-derived or otherwise — may unlock it.
  const env = modelPlaneEnv(AMBIENT, { modelAuthKey: 'ADLC_MANIFEST_KEY' });
  assert.equal(env.ADLC_MANIFEST_KEY, undefined);
});

// ---------------------------------------------------------------------------
// The un-engaged path is untouched
// ---------------------------------------------------------------------------

test('with NO registry, dispatch still honours config.modelAuthKey exactly as before', async () => {
  const rec = [];
  const deps = buildLiveDeps({
    repo: '/repo',
    statusDir: undefined,
    sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    config: { adapter: 'claude-code', gate: { test: 'true' }, modelAuthKey: 'ANTHROPIC_API_KEY', timeoutMinutes: 1 },
    io: fakeIo(rec), // no seats at all
  });
  await deps.dispatch({ ticket: byId('T-SUB'), worktree: '/wt/x', startSha: 'SHA', strike: 1, deadEnds: [] });
  assert.equal(rec[0].env.ANTHROPIC_API_KEY, 'AMBIENT-anthropic-credential', 'the legacy exemption still applies');
  assert.equal(rec[0].env.OPENAI_API_KEY, undefined, 'and still strips every other secret');
});

// ---------------------------------------------------------------------------
// transportStatus — a chosen context, never an attested one
// ---------------------------------------------------------------------------

function recordedData(adlcCalls) {
  return adlcCalls.map((argv) => JSON.parse(argv[argv.indexOf('--data') + 1]));
}

test('a recorded dispatch says the transport was SELECTED, never attested', () => {
  const adlcCalls = [];
  const deps = depsFor([], { ioExtra: { adlc: (argv) => { adlcCalls.push(argv); return { status: 0, stdout: '{}' }; } } });
  deps.recordDispatchUsage({
    ticket: byId('T-SUB'),
    result: { exitCode: 0, output: 'ok', usageStatus: 'unreported' },
    strike: 1,
  });
  const [data] = recordedData(adlcCalls);
  assert.equal(data.transport, 'subscription:anthropic-max');
  assert.equal(data.transportStatus, 'selected',
    'the label records the credential context CHOSEN for the call, not what served it');
  assert.notEqual(data.transportStatus, 'attested');
});

test('EVERY transport class records "selected" — "attested" is unreachable, not merely unused', () => {
  // "attested" is reserved for the deferred half (#396 AC6). Reserving a value
  // in prose is worthless, but a source-text scan for the word is a hollow test
  // (it flags prose in a comment and misses a computed string). Sweep the
  // reachable INPUT SPACE instead: every §4a channel, i.e. every transport
  // class the registry can express, must record "selected".
  const adlcCalls = [];
  const deps = depsFor([], { ioExtra: { adlc: (argv) => { adlcCalls.push(argv); return { status: 0, stdout: '{}' }; } } });
  const seats = realSeats();

  // The default fixture routes only to subscription and gateway seats — no
  // ticket lands on frontier-metered — so sweeping it alone would leave the
  // `api` class untested while the title claimed otherwise. The swapped
  // registry puts the api transport on the channel a ticket DOES route to.
  const seen = new Set();
  const sweep = (seatMap, d) => {
    for (const [id, entry] of seatMap) {
      d.recordDispatchUsage({
        ticket: byId(id),
        result: { exitCode: 0, output: 'ok', usageStatus: 'unreported' },
        strike: 1,
      });
      seen.add(entry.seat.transport.split(':')[0]);
    }
  };
  sweep(seats, deps);

  const swapped = {
    ...REGISTRY,
    channels: {
      ...REGISTRY.channels,
      frontier: REGISTRY.channels['frontier-metered'],
      'frontier-metered': REGISTRY.channels.frontier,
    },
  };
  const apiSeats = realSeats(swapped);
  sweep(apiSeats, depsFor([], {
    seats: apiSeats,
    ioExtra: { adlc: (argv) => { adlcCalls.push(argv); return { status: 0, stdout: '{}' }; } },
  }));

  const statuses = recordedData(adlcCalls).map((d) => d.transportStatus);
  assert.ok(statuses.length > 0, 'the sweep actually recorded something');
  assert.deepEqual([...new Set(statuses)], ['selected'], `every recorded dispatch is "selected": ${statuses}`);
  // EVERY class in the §4b taxonomy that a build channel can carry — asserted
  // individually so a fixture change that silently drops one fails here.
  for (const klass of ['subscription', 'gateway', 'api']) {
    assert.ok(seen.has(klass), `the sweep must exercise the "${klass}" class; saw: ${[...seen]}`);
  }
});

// ---------------------------------------------------------------------------
// No credential VALUE reaches any sink that gained transport awareness
// ---------------------------------------------------------------------------

test('a decoy secret never appears in the transcript header or the recorded carrier', async () => {
  const written = [];
  const adlcCalls = [];
  const rec = [];
  const deps = depsFor(rec, {
    ioExtra: {
      appendLog: (_path, text) => written.push(text),
      adlc: (argv) => { adlcCalls.push(argv); return { status: 0, stdout: '{}' }; },
    },
  });
  await deps.dispatch({ ticket: byId('T-SUB'), worktree: '/wt/T-SUB', startSha: 'SHA', strike: 1, deadEnds: [] });
  deps.recordDispatchUsage({
    ticket: byId('T-SUB'),
    result: { exitCode: 0, output: 'ok', usageStatus: 'unreported' },
    strike: 1,
  });

  const sinks = [...written, ...adlcCalls.map((a) => a.join(' '))].join('\n');
  for (const secret of ['AMBIENT-anthropic-credential', 'AMBIENT-openai-credential', 'ledger-signing-key-must-never-leak']) {
    assert.ok(!sinks.includes(secret), `a credential VALUE leaked into a sink: ${secret}`);
  }
  assert.ok(sinks.includes('subscription:anthropic-max'), 'the transport itself is recorded — it is not a secret');
});
