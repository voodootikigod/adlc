import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveDeps } from '../lib/live-deps.mjs';
import { runFleet } from '../lib/run.mjs';

// A permissive fake git: records calls, returns sensible defaults by verb.
function fakeGit(rec) {
  return (dir) => (...args) => {
    rec.git.push({ dir, args });
    const verb = args[0];
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
    adlc: (args) => { rec.adlc.push(args); return { status: 0, stdout: '{"detected":false}' }; },
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
const newRec = () => ({ git: [], adlc: [], spawn: [] });

test('dispatch spawns claude -p on the MODEL plane: unsandboxed, provider auth retained (AC1/K2)', () => {
  const rec = newRec();
  const deps = makeDeps(rec);
  const r = deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  const claudeCall = rec.spawn.find((s) => s.cmd === 'claude');
  assert.ok(claudeCall, 'claude was spawned directly (not wrapped in bwrap)');
  assert.ok(claudeCall.args.includes('-p') && claudeCall.args.includes('acceptEdits'));
  assert.equal(claudeCall.env.ADLC_P4_ENFORCEMENT, '1');
  assert.equal(claudeCall.env.ADLC_TICKET, 'T1');
  assert.equal(claudeCall.env.ANTHROPIC_API_KEY, 'sk-anthropic', 'model plane keeps its own provider auth');
  assert.equal(claudeCall.env.OPENAI_API_KEY, undefined, 'unrelated provider key stripped');
  assert.equal(r.exitCode, 0);
});

test('gate runs build+test THROUGH the sandbox with a scrubbed repo-command env (AC1)', () => {
  const rec = newRec();
  const deps = makeDeps(rec);
  const r = deps.gate({ ticket, worktree: '/wt/T1', startSha: 'SHA' });
  assert.equal(r.ok, true, r.output);
  // build+test were wrapped in the sandbox (bwrap) — repo-command plane.
  const wrapped = rec.spawn.filter((s) => s.cmd === 'bwrap');
  assert.ok(wrapped.length >= 2, 'build and test both ran through the sandbox wrapper');
  const anyCmd = wrapped.find((s) => s.args.join(' ').includes('npm run build'));
  assert.ok(anyCmd, 'the gate build command ran inside the sandbox');
  // env passed to the sandboxed command is scrubbed of secrets.
  assert.equal(anyCmd.env.OPENAI_API_KEY, undefined);
  assert.equal(anyCmd.env.ANTHROPIC_API_KEY, undefined, 'repo-command plane strips ALL provider keys');
  assert.equal(anyCmd.env.PATH, '/usr/bin');
});

test('gate invokes rails-guard with --base <startSha> --ticket <id>', () => {
  const rec = newRec();
  makeDeps(rec).gate({ ticket, worktree: '/wt/T1', startSha: 'TIP' });
  const rg = rec.adlc.find((a) => a[0] === 'rails-guard');
  assert.ok(rg, 'rails-guard was invoked');
  assert.equal(rg[rg.indexOf('--base') + 1], 'TIP');
  assert.equal(rg[rg.indexOf('--ticket') + 1], 'T1');
});

test('prosecute drives the review runner over the ticket startSha (AC1)', () => {
  const rec = newRec();
  let seen;
  const deps = makeDeps(rec, { reviewRunner: (ctx) => { seen = ctx; return { ok: true, findings: [] }; } });
  const r = deps.prosecute({ ticket, worktree: '/wt/T1', startSha: 'TIP' });
  assert.equal(seen.startSha, 'TIP');
  assert.equal(r.verdict, 'pass');
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
});
