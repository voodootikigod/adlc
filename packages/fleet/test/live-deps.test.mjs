import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveDeps } from '../lib/live-deps.mjs';
import { findInner } from './helpers/worker-calls.mjs';
import { runFleet } from '../lib/run.mjs';

// A permissive fake git: records calls, returns sensible defaults by verb.
// Model git's PER-WORKTREE HEAD. Each worktree has its own checked-out branch, which
// `worktree add -b <branch> <path>` establishes — there is no `checkout` in the
// integration flow at all any more. A stub that returned a single global branch (or
// '', which real git never returns) would make correct branch-identity checks look
// broken (AGENTS.md: a mock cannot catch drift in the thing it imitates).
function fakeGit(rec) {
  const headOf = new Map(); // worktree path suffix → its checked-out branch
  const branchFor = (dir) => {
    for (const [p, b] of headOf) if (String(dir).endsWith(p)) return b;
    return headOf.get(String(dir)) ?? 'main';
  };
  return (dir) => (...args) => {
    rec.git.push({ dir, args });
    const verb = args[0];
    if (verb === 'worktree' && args[1] === 'add') {
      const i = args.indexOf('-b');
      if (i >= 0) headOf.set(String(args[i + 2]), String(args[i + 1])); // add -b <branch> <path>
      else headOf.set(String(args[2]), String(args[3] ?? 'main'));       // add <path> <branch>
      return '';
    }
    if (verb === 'checkout') {
      const target = args.slice(1).filter((a) => !String(a).startsWith('-')).pop();
      if (target) headOf.set(String(dir), String(target));
      return '';
    }
    if (verb === 'symbolic-ref') return branchFor(dir);
    if (verb === 'diff') return 'packages/fleet/lib/x.mjs'; // in-scope change
    if (verb === 'status') return ''; // no protected-path candidates
    if (verb === 'show') throw new Error('no such path at rev'); // no template
    if (verb === 'rev-parse') return 'SHA';
    return '';
  };
}

function fakeIo(rec, env) {
  return {
    git: fakeGit(rec),
    adlc: (args) => { rec.adlc.push(args); return { status: 0, stdout: '{"verdict":"clean","signals":[]}' }; },
    appendLog: (p, text, opts) => { rec.logs.push({ path: p, text, opts }); },
    adlcAsync: async (args) => { rec.adlc.push(args); return { status: 0, stdout: '' }; },
    spawnWorker: (cmd, args, opts) => {
      rec.spawn.push({ cmd, args, env: opts?.env });
      if (cmd === 'claude') return { status: 0, stdout: 'TICKET-DONE', stderr: '' };
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    readFile: () => undefined,
    exists: () => false,
    mkdirp: () => {},
    writeJson: () => {},
    ensureGitignore: () => {},
    env,
    hasGh: () => false,
  };
}

const sandboxSpec = { mode: 'sandbox', backend: { name: 'bubblewrap' } };
const config = { gate: { build: 'npm run build', test: 'npm test' }, prosecuteFailOn: 'medium', modelAuthKey: 'ANTHROPIC_API_KEY', timeoutMinutes: 1 };
const env = { PATH: '/usr/bin', HOME: '/home/real', ANTHROPIC_API_KEY: 'sk-anthropic', OPENAI_API_KEY: 'sk-openai', AWS_SECRET_ACCESS_KEY: 'aws' };
const ticket = { id: 'T1', title: 'T1', scope: ['packages/fleet/**'], body: 'do it', edges: [] };

function makeDeps(rec, over = {}) {
  return buildLiveDeps({
    repo: '/repo', config, statusDir: undefined, sandboxSpec,
    reviewRunner: over.reviewRunner ?? (() => ({ ok: true, findings: [] })),
    io: fakeIo(rec, env),
  });
}
const newRec = () => ({ git: [], adlc: [], spawn: [], logs: [] });

test('dispatch spawns claude -p on the MODEL plane: network open, filesystem bounded (AC1/K2, #395)', async () => {
  const rec = newRec();
  const deps = makeDeps(rec);
  const r = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  const claudeCall = findInner(rec.spawn, 'claude');
  assert.ok(claudeCall, 'claude was spawned');
  // #395 inverted this: the worker used to run UNWRAPPED, which made the
  // repo-authored gate commands in its allowlist a write path to everything the
  // operator can write. It is wrapped now — but with egress still open (K2).
  assert.equal(claudeCall.wrapper.cmd, 'bwrap', 'the worker process itself is contained');
  assert.ok(!claudeCall.wrapper.args.includes('--unshare-net'),
    'network egress is PRESERVED on the model plane — a worker that cannot reach its provider cannot work');
  assert.ok(claudeCall.args.includes('-p') && claudeCall.args.includes('acceptEdits'));
  assert.equal(claudeCall.env.ADLC_P4_ENFORCEMENT, '1');
  assert.equal(claudeCall.env.ADLC_TICKET, 'T1');
  assert.equal(claudeCall.env.ANTHROPIC_API_KEY, 'sk-anthropic', 'model plane keeps its own provider auth');
  assert.equal(claudeCall.env.OPENAI_API_KEY, undefined, 'unrelated provider key stripped');
  assert.equal(r.exitCode, 0);
});

test('gate runs build+test THROUGH the sandbox with a scrubbed repo-command env (AC1)', async () => {
  const rec = newRec();
  const deps = makeDeps(rec);
  const r = await deps.gate({ ticket, worktree: '/wt/T1', startSha: 'SHA' });
  assert.equal(r.ok, true, r.output);
  // build+test were wrapped in the sandbox (bwrap) — repo-command plane.
  const wrapped = rec.spawn.filter((s) => s.cmd === 'bwrap' && s.args.includes('--unshare-net'));
  assert.ok(wrapped.length >= 2, 'build and test both ran through the no-network sandbox wrapper');
  const anyCmd = wrapped.find((s) => s.args.join(' ').includes('npm run build'));
  assert.ok(anyCmd, 'the gate build command ran inside the sandbox');
  // env passed to the sandboxed command is scrubbed of secrets.
  assert.equal(anyCmd.env.OPENAI_API_KEY, undefined);
  assert.equal(anyCmd.env.ANTHROPIC_API_KEY, undefined, 'repo-command plane strips ALL provider keys');
  assert.equal(anyCmd.env.PATH, '/usr/bin');
});

test('gate invokes rails-guard with --base <startSha> --ticket <id>', async () => {
  const rec = newRec();
  await makeDeps(rec).gate({ ticket, worktree: '/wt/T1', startSha: 'TIP' });
  const rg = rec.adlc.find((a) => a[0] === 'rails-guard');
  assert.ok(rg, 'rails-guard was invoked');
  assert.equal(rg[rg.indexOf('--base') + 1], 'TIP');
  assert.equal(rg[rg.indexOf('--ticket') + 1], 'T1');
});

test('prosecute drives the review runner over the ticket startSha (AC1)', async () => {
  const rec = newRec();
  let seen;
  const deps = makeDeps(rec, { reviewRunner: (ctx) => { seen = ctx; return { ok: true, findings: [] }; } });
  const r = await deps.prosecute({ ticket, worktree: '/wt/T1', startSha: 'TIP' });
  assert.equal(seen.startSha, 'TIP');
  assert.equal(r.verdict, 'pass');
});

test('postMergeGate AWAITS the gate before pinning HEAD — a commit landing DURING the gate is caught (F4/N2)', async () => {
  // runGates is async: it runs the build/test commands to completion. The post-gate branch
  // and SHA assertions exist to reject a verdict whose commit moved WHILE the gate ran. If
  // postMergeGate reads HEAD without awaiting runGates, those assertions fire BEFORE the
  // gate's commands ever execute, so the HEAD move is invisible and a stale passing verdict
  // is trusted (adversarial-review round-30, high/0.99).
  //
  // This test moves HEAD asynchronously, from inside the gate's spawn — the flip lands only
  // after a microtask, i.e. AFTER the point where the un-awaited code already ran its
  // assertions. So the buggy (sync) version pins the pre-gate SHA and returns ok; only the
  // awaited version observes the moved HEAD and refuses.
  let head = 'PRE';
  const io = {
    git: () => (...args) => {
      if (args[0] === 'symbolic-ref') return 'fleet/run-z'; // still on the branch throughout
      if (args[0] === 'rev-parse') return head;
      return '';
    },
    // The gate's build/test run through here. Simulate an external commit landing mid-gate,
    // but only AFTER a microtask so it cannot be observed by an assertion that skipped the await.
    spawnWorker: async () => { await Promise.resolve(); head = 'POST'; return { status: 0, stdout: '', stderr: '' }; },
    mkdirp: () => {},
    adlc: () => ({ status: 0, stdout: '' }),
    adlcAsync: async () => ({ status: 0, stdout: '' }),
    appendLog: () => {},
    readFile: () => undefined,
    exists: () => false,
    writeJson: () => {},
    ensureGitignore: () => {},
    hasGh: () => false,
    env,
  };
  const deps = buildLiveDeps({
    repo: '/repo', config, statusDir: undefined, sandboxSpec,
    reviewRunner: () => ({ ok: true, findings: [] }),
    io,
  });

  const r = await deps.postMergeGate({ integrationBranch: 'fleet/run-z' });

  assert.equal(r.ok, false, 'a HEAD move DURING the gate must fail the post-merge gate, not pass');
  assert.match(r.output, /HEAD moved/);
});

test('postMergeGate REFUSES (ok:false) when the integration worktree is not on its branch BEFORE gating', async () => {
  // The pre-gate assertOnBranch guard: if the integration worktree is not on the run branch
  // when the gate is about to run, the gate must refuse rather than attribute a build to the
  // wrong branch. Pins the `ok:false` refusal so a bool-flip to ok:true (a refused gate read
  // as passing) is caught.
  const io = {
    git: () => (...args) => {
      if (args[0] === 'symbolic-ref') return 'some-other-branch'; // NOT the run branch
      if (args[0] === 'rev-parse') return 'SHA';
      return '';
    },
    spawnWorker: async () => ({ status: 0, stdout: '', stderr: '' }),
    mkdirp: () => {}, adlc: () => ({ status: 0, stdout: '' }), adlcAsync: async () => ({ status: 0, stdout: '' }),
    appendLog: () => {}, readFile: () => undefined, exists: () => false, writeJson: () => {},
    ensureGitignore: () => {}, hasGh: () => false, env,
  };
  const deps = buildLiveDeps({ repo: '/repo', config, statusDir: undefined, sandboxSpec, reviewRunner: () => ({ ok: true, findings: [] }), io });

  const r = await deps.postMergeGate({ integrationBranch: 'fleet/run-z' });

  assert.equal(r.ok, false, 'a wrong-branch worktree must make the gate refuse, not pass');
  assert.match(r.output, /refusing to gate/);
});

test('runFleet driven by live deps advances a ticket build→gate→prosecute→merge (AC1)', async () => {
  const rec = newRec();
  const deps = makeDeps(rec);
  const cfg = { ...config, base: 'main', concurrency: 2, baseSha: 'BASE' };
  const summary = await runFleet({ all: [ticket], runId: 'z', config: cfg, deps });
  assert.equal(summary.results.T1, 'merged');
  assert.equal(summary.integrationBranch, 'fleet/run-z');
  // The merge targeted the integration branch via rebase-first.
  assert.ok(rec.git.some((g) => g.args[0] === 'merge'), 'a merge occurred');
  assert.ok(rec.git.some((g) => g.args[0] === 'rebase'), 'rebase-first before merge');
  // fakeIo.hasGh() is false, so the REAL openPR reports { opened:false } — the run must
  // not fabricate a PR count from that (round-31).
  assert.equal(summary.prCount, 0, 'no gh → openPR reports not-opened → prCount stays 0, not fabricated');
});

test('prosecute bounds the reviewer by the SMALLER of its own budget and the remaining wall clock: a long remainder never widens it, a short one shrinks it, none leaves the default (agy fleet3 c3)', async () => {
  const { DEFAULT_REVIEW_TIMEOUT_MS } = await import('../lib/review-runner.mjs');
  const seen = [];
  const deps = makeDeps(newRec(), { reviewRunner: (ctx) => { seen.push(ctx?.timeoutMs); return { ok: true, findings: [] }; } });
  await deps.prosecute({ ticket, worktree: '/wt/T1', startSha: 'TIP', remainingMs: 5000 });
  await deps.prosecute({ ticket, worktree: '/wt/T1', startSha: 'TIP', remainingMs: DEFAULT_REVIEW_TIMEOUT_MS * 6 });
  await deps.prosecute({ ticket, worktree: '/wt/T1', startSha: 'TIP' });
  assert.deepEqual(seen, [5000, DEFAULT_REVIEW_TIMEOUT_MS, undefined]);
});
