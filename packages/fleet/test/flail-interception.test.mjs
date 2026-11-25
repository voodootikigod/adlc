import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeStrikeTranscriptJsonl } from '../lib/adapters/_shared.mjs';
import {
  analyzeFlailTranscript,
  classifyFlailAction,
  formatAntiFlailBrief,
  checkFlail,
} from '../lib/gates.mjs';
import { advanceTicket, REASON_CODES } from '../lib/scheduler.mjs';
import { fleetTranscriptPath, buildLiveDeps } from '../lib/live-deps.mjs';
import { runFleet } from '../lib/run.mjs';

test('serializeStrikeTranscriptJsonl emits normalized JSONL readable by @adlc/flail-detector', () => {
  const jsonl = serializeStrikeTranscriptJsonl({
    ticketId: 'T-42',
    strike: 1,
    adapter: 'codex',
    output: 'Error: ENOENT missing foo\nError: ENOENT missing foo\nError: ENOENT missing foo\n',
    exitCode: 1,
    timedOut: false,
    toolEvents: [
      { name: 'Edit', input: { file_path: 'outside/rogue.mjs' } },
      { name: 'Read', input: { file_path: 'outside/readme.md' } },
    ],
  });
  const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'strike_meta');
  assert.equal(lines[0].ticketId, 'T-42');
  assert.equal(lines[0].strike, 1);
  assert.equal(lines[1].type, 'tool_use');
  assert.equal(lines[1].name, 'Edit');

  const analysis = analyzeFlailTranscript(jsonl, ['src/**']);
  assert.equal(analysis.flail, true);
  assert.equal(analysis.action, 'corrective-brief');
  assert.ok(analysis.signals.some((s) => s.type === 'repeated-error'));
  assert.ok(analysis.signals.some((s) => s.type === 'scope-violation'));
  assert.match(analysis.brief, /repeated-error/);
  assert.match(analysis.brief, /scope-violation/);
  assert.match(analysis.brief, /outside\/rogue\.mjs/);
  // Read-only tool_use must not trigger scope-violation.
  assert.doesNotMatch(analysis.brief, /outside\/readme\.md/);
});

test('classifyFlailAction aborts on size/budget ceilings and requests corrective-brief on recoverable signals', () => {
  assert.equal(classifyFlailAction([{ type: 'repeated-error' }]), 'corrective-brief');
  assert.equal(classifyFlailAction([{ type: 'scope-violation' }, { type: 'edit-churn' }]), 'corrective-brief');
  assert.equal(classifyFlailAction([{ type: 'size', bytes: 999, maxBytes: 100 }]), 'abort');
  assert.equal(classifyFlailAction([{ type: 'budget', spentTokens: 200, budget: 100 }]), 'abort');
});

test('formatAntiFlailBrief redacts secrets and covers all 5 flail signal types', () => {
  const fakeKey = ['sk', 'ant', 'api03', '1234567890abcdefghijklmnop'].join('-');
  const brief = formatAntiFlailBrief([
    { type: 'repeated-error', entries: [{ signature: `auth failed ${fakeKey}`, count: 3 }] },
    { type: 'scope-violation', entries: [{ path: 'etc/other.mjs' }] },
    { type: 'edit-churn', entries: [{ path: 'src/a.mjs', count: 6 }] },
    { type: 'size', bytes: 2048, maxBytes: 1024 },
    { type: 'budget', spentTokens: 5000, budget: 4000 },
  ]);
  assert.equal(brief.includes(fakeKey), false);
  assert.match(brief, /repeated-error/);
  assert.match(brief, /scope-violation/);
  assert.match(brief, /edit-churn/);
  assert.match(brief, /size/);
  assert.match(brief, /budget/);
});

test('analyzeFlailTranscript detects clean transcripts and hard budget/size aborts', () => {
  const cleanJsonl = serializeStrikeTranscriptJsonl({
    ticketId: 'T-CLEAN',
    strike: 1,
    output: 'All tests passed\n',
    exitCode: 0,
  });
  const clean = analyzeFlailTranscript(cleanJsonl, ['src/**']);
  assert.equal(clean.flail, false);
  assert.equal(clean.action, null);
  assert.equal(clean.brief, null);

  const overBudget = analyzeFlailTranscript(cleanJsonl, ['src/**'], { spentTokens: 5000, budget: 1000 });
  assert.equal(overBudget.flail, true);
  assert.equal(overBudget.action, 'abort');
  assert.match(overBudget.brief, /budget/);
});

test('checkFlail attaches brief and action on flail verdicts while preserving fail-open behavior', () => {
  const doc = JSON.stringify({
    verdict: 'flail',
    signals: [{ type: 'scope-violation', entries: [{ path: 'bad/file.mjs' }] }],
  });
  const res = checkFlail('/log', ['src/**'], {
    exec: () => {
      const e = new Error('flail');
      e.status = 2;
      e.stdout = doc;
      throw e;
    },
  });
  assert.equal(res.flail, true);
  assert.equal(res.action, 'corrective-brief');
  assert.match(res.brief, /bad\/file\.mjs/);
});

test('advanceTicket injects fenced FLAIL_BRIEF into Strike 2 deadEnds on corrective-brief and aborts on hard flail', async () => {
  const ticket = { id: 'T-STRIKE', scope: ['src/**'] };
  const seenDeadEnds = [];
  const flailCalls = [];

  const outcome = await advanceTicket(ticket, {
    dispatch: ({ strike, deadEnds }) => {
      seenDeadEnds.push({ strike, deadEnds: [...deadEnds] });
      if (strike === 1) return { exitCode: 1, output: 'Error: failed build', timedOut: false };
      return { exitCode: 0, output: 'fixed', timedOut: false };
    },
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    merge: () => ({ ok: true }),
    flail: ({ strike }) => {
      flailCalls.push(strike);
      return {
        flail: true,
        action: 'corrective-brief',
        brief: 'Flail-detector intercepted: stay inside src/**',
      };
    },
  }, { maxStrikes: 2 });

  assert.equal(outcome.state, 'merged');
  assert.equal(outcome.strikes, 2);
  assert.deepEqual(flailCalls, [1]);
  assert.equal(seenDeadEnds.length, 2);
  assert.ok(
    seenDeadEnds[1].deadEnds.some((d) => d.includes('FLAIL_BRIEF') && d.includes('stay inside src/**')),
    'Strike 2 must receive the fenced anti-flail corrective brief',
  );

  // Hard flail (action: 'abort' or legacy { flail: true }) skips Strike 2.
  const aborted = await advanceTicket(ticket, {
    dispatch: () => ({ exitCode: 1, output: 'boom', timedOut: false }),
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    merge: () => ({ ok: true }),
    flail: () => ({ flail: true, action: 'abort', brief: 'budget exceeded' }),
  }, { maxStrikes: 2 });
  assert.equal(aborted.state, 'failed');
  assert.equal(aborted.reasonCode, REASON_CODES.FLAIL);
  assert.equal(aborted.strikes, 1);
});

test('fleetTranscriptPath places per-strike JSONL under .adlc/tmp/fleet-transcripts/', () => {
  const p = fleetTranscriptPath(null, '/repo', 'T-9', 2);
  assert.equal(p, '/repo/.adlc/tmp/fleet-transcripts/T-9-strike-2.jsonl');

  // Defaults on serializeStrikeTranscriptJsonl: strike=1, timedOut=false.
  const defaultMeta = JSON.parse(serializeStrikeTranscriptJsonl({ ticketId: 'T-DEF' }).trim().split('\n')[0]);
  assert.equal(defaultMeta.strike, 1);
  assert.equal(defaultMeta.timedOut, false);
});

test('buildLiveDeps dispatch persists per-strike JSONL transcript and flail analyzes it', async () => {
  const written = new Map();
  const io = {
    env: { HOME: '/h', PATH: '/usr/bin' },
    git: () => () => '',
    adlc: () => ({ status: 0, stdout: JSON.stringify({ verdict: 'clean', signals: [] }), stderr: '' }),
    adlcAsync: async () => ({ status: 0, stdout: '', stderr: '' }),
    spawnWorker: async () => ({
      status: 1,
      stdout: 'Error: ENOENT missing file\nError: ENOENT missing file\nError: ENOENT missing file\n',
      stderr: '',
      signal: null,
    }),
    readFile: (p) => written.get(p) ?? '',
    exists: (p) => written.has(p),
    isFile: () => false,
    mkdirp: () => {},
    writeJson: () => {},
    appendLog: (p, text, { reset = false } = {}) => {
      written.set(p, reset ? text : `${written.get(p) ?? ''}${text}`);
    },
    ensureGitignore: () => {},
    copyTree: () => {},
  };

  const deps = buildLiveDeps({
    repo: '/repo',
    statusDir: '/repo/.adlc',
    config: { adapter: 'codex', timeoutMs: 5000, sandbox: { mode: 'off' } },
    sandboxSpec: { mode: 'off', network: 'none' },
    io,
  });

  const ticket = { id: 'T-LIVE', title: 'Test', body: 'Do work', scope: ['src/**'] };
  await deps.dispatch({ ticket, strike: 1, deadEnds: [], worktree: '/repo/.worktrees/t-live', branch: 'fleet/t-live' });

  const expectedTranscript = fleetTranscriptPath('/repo/.adlc', '/repo', 'T-LIVE', 1);
  assert.ok(written.has(expectedTranscript), `expected transcript at ${expectedTranscript}`);

  const flailRes = deps.flail({ ticket, strike: 1 });
  assert.equal(flailRes.flail, true);
  assert.equal(flailRes.action, 'corrective-brief');
  assert.match(flailRes.brief, /repeated-error/);

  // Two repeated errors (established default maxRepeat=2) also fire structured flail.
  const twoErrJsonl = serializeStrikeTranscriptJsonl({
    ticketId: 'T-2',
    strike: 1,
    output: 'Error: EACCES permission denied\nError: EACCES permission denied\n',
    exitCode: 1,
  });
  const twoErr = analyzeFlailTranscript(twoErrJsonl, ['src/**']);
  assert.equal(twoErr.flail, true);

  // Malformed detector signal entries never throw (fail-open / safe formatting).
  const malformedEntryDoc = JSON.stringify({
    verdict: 'flail',
    signals: [{ type: 'repeated-error', entries: [null, 42] }],
  });
  const safeRes = checkFlail('/log', ['src/**'], {
    exec: () => { const e = new Error('flail'); e.status = 2; e.stdout = malformedEntryDoc; throw e; },
  });
  assert.equal(safeRes.flail, true);
  assert.match(safeRes.brief, /repeated-error/);

  const malformedSigDoc = JSON.stringify({ verdict: 'flail', signals: [null] });
  const failOpenRes = checkFlail('/log', ['src/**'], {
    exec: () => { const e = new Error('flail'); e.status = 2; e.stdout = malformedSigDoc; throw e; },
  });
  assert.equal(failOpenRes.flail, false);
  assert.equal(failOpenRes.failedOpen, true);
});

test('runFleet forwards strike through buildEffects.flail into deps.flail', async () => {
  const seenStrikes = [];
  const seenDeadEnds = [];
  const ticket = { id: 'T-RUN', title: 'Run test', body: 'Work', scope: ['src/**'] };
  const result = await runFleet({
    all: [ticket],
    runId: 'run-flail-forward',
    config: { base: 'main', baseSha: 'aaa111', concurrency: 1, maxStrikes: 2, noPr: true, noComplete: true },
    deps: {
      createWorktree: () => ({ path: '/tmp/wt-run', branch: 'fleet/t-run', startSha: 'aaa111' }),
      cleanup: () => {},
      dispatch: ({ strike, deadEnds }) => {
        seenDeadEnds.push({ strike, deadEnds: [...deadEnds] });
        if (strike === 1) return { exitCode: 1, output: 'failed once', timedOut: false };
        return { exitCode: 0, output: 'done', timedOut: false };
      },
      gate: () => ({ ok: true }),
      prosecute: () => ({ verdict: 'pass' }),
      flail: ({ strike }) => {
        seenStrikes.push(strike);
        return { flail: true, action: 'corrective-brief', brief: 'Stay inside src/**' };
      },
      mergeToIntegration: () => ({ mergeSha: 'bbb222', preMergeSha: 'aaa111' }),
      postMergeGate: () => ({ ok: true }),
      revertMerge: () => {},
    },
  });
  assert.equal(result.merged, 1);
  assert.deepEqual(seenStrikes, [1], 'buildEffects.flail must forward strike to deps.flail');
  assert.ok(seenDeadEnds[1].deadEnds.some((d) => d.includes('FLAIL_BRIEF')));
});
