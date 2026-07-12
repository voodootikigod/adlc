#!/usr/bin/env node
// @adlc/fleet — parallel ticket orchestration on the ADLC.
// Exit codes (CONVENTIONS): 0 = ok · 1 = operational error · 2 = a ticket failed/blocked.

import { parseArgs, gateFail, opError, printJson } from '@adlc/core';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadPlan, activeTickets } from '../lib/plan.mjs';
import { planRound } from '../lib/scheduler.mjs';
import { loadConfig, resolveRunConfig } from '../lib/config.mjs';
import { loadStatus } from '../lib/status.mjs';
import { readLockOwner, forceUnlock, releaseLock } from '../lib/lock.mjs';
import { runPreflight } from '../lib/preflight.mjs';
import { reconcileRun } from '../lib/resume.mjs';
import { buildLiveDeps, defaultIo } from '../lib/live-deps.mjs';
import { runFleet } from '../lib/run.mjs';
import { selfIdentity, lockProbes } from '../lib/proc.mjs';
import { Sandbox } from '../lib/sandbox.mjs';
import { repoCommandEnv } from '../lib/env-scrub.mjs';

const USAGE = `fleet — parallel ADLC ticket orchestration

Usage:
  fleet run [--concurrency N] [--dry-run] [--tickets T1,T2] [--base B] [--json]
            [--i-am-in-a-disposable-container]
  fleet status [--json]
  fleet unlock

Exit codes: 0 ok · 1 operational error · 2 a ticket failed/blocked.`;

const raw = process.argv.slice(2);
const sub = raw[0];

if (!sub || sub === '--help' || sub === '-h') {
  console.log(USAGE);
  process.exit(0);
}

const dir = join(process.cwd(), '.adlc');

function parseFlags(args) {
  const { values } = parseArgs({
    args,
    options: {
      concurrency: { type: 'string' },
      'dry-run': { type: 'boolean' },
      tickets: { type: 'string' },
      base: { type: 'string' },
      json: { type: 'boolean' },
      'i-am-in-a-disposable-container': { type: 'boolean' },
      adapter: { type: 'string' },
      'adapter-command': { type: 'string' },
      'adapter-args': { type: 'string' },
    },
    allowPositionals: true,
  });
  return values;
}

if (sub === 'status') {
  const flags = parseFlags(raw.slice(1));
  const status = loadStatus(dir);
  if (!status) { console.log('no active fleet run (no .adlc/fleet-status.json)'); process.exit(0); }
  if (flags.json) printJson(status);
  else {
    console.log(`run ${status.runId}  base=${status.base}  integration=${status.integrationBranch}  sandbox=${status.sandboxMode}`);
    for (const [id, r] of Object.entries(status.tickets)) {
      const pros = r.prosecution ? `  prosecution=${r.prosecution}` : '';
      console.log(`  ${id.padEnd(8)} ${String(r.state).padEnd(10)} strikes=${r.strikes ?? 0}${pros}${r.reason ? `  (${r.reason})` : ''}`);
    }
  }
  process.exit(0);
}

if (sub === 'unlock') {
  const owner = readLockOwner(dir);
  if (!owner) { console.log('no lock held'); process.exit(0); }
  forceUnlock(dir);
  console.log(`released lock (was pid ${owner.pid} on ${owner.host}, run ${owner.runId ?? '?'})`);
  process.exit(0);
}

if (sub === 'run') {
  const flags = parseFlags(raw.slice(1));
  const config = resolveRunConfig(loadConfig(dir), {
    concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
    base: flags.base,
    disposableContainer: flags['i-am-in-a-disposable-container'] === true,
    adapter: flags.adapter,
    // Operator-local worker binary override (A2) — CLI only, never repo config.
    adapterCommand: flags['adapter-command'] ?? undefined,
    adapterArgs: flags['adapter-args'] ? flags['adapter-args'].split(',') : undefined,
  });
  for (const w of config.warnings) console.error(`warning: ${w}`);

  let ticketsFile;
  try {
    ticketsFile = loadPlan(join(dir, 'tickets.json'));
  } catch (e) {
    opError(`could not load .adlc/tickets.json: ${e.message}`);
  }
  const all = ticketsFile.tickets ?? ticketsFile;
  const onlyIds = flags.tickets ? flags.tickets.split(',').map((s) => s.trim()) : undefined;

  // --dry-run: compute and print the plan without creating worktrees or workers.
  if (flags['dry-run']) {
    const cap = config.concurrency;
    const { admit, blocked } = planRound(all, { statusById: {}, inFlightIds: [], cap: Number.MAX_SAFE_INTEGER, onlyIds });
    const active = activeTickets(all).filter((t) => !onlyIds || onlyIds.includes(t.id));
    const readyIds = new Set(admit.map((t) => t.id));
    const waiting = active.filter((t) => !readyIds.has(t.id) && !blocked.includes(t.id));
    const plan = {
      integrationBranch: 'fleet/run-<runId>',
      concurrency: cap,
      base: config.base,
      readyNow: admit.map((t) => t.id),
      firstBatch: admit.slice(0, cap).map((t) => t.id),
      waitingOnDeps: waiting.map((t) => t.id),
      subsetBlocked: blocked,
      completedExcluded: all.length - active.length,
    };
    if (flags.json) { printJson(plan); process.exit(0); }
    console.log(`fleet dry-run — integration branch ${plan.integrationBranch}, concurrency ${cap}, base ${config.base}`);
    console.log(`  ready now (${plan.readyNow.length}): ${plan.readyNow.join(', ') || '(none)'}`);
    console.log(`  first batch (cap ${cap}): ${plan.firstBatch.join(', ') || '(none)'}`);
    console.log(`  waiting on deps (${plan.waitingOnDeps.length}): ${plan.waitingOnDeps.join(', ') || '(none)'}`);
    if (plan.subsetBlocked.length) console.log(`  subset-blocked: ${plan.subsetBlocked.join(', ')}`);
    console.log(`  completed (excluded): ${plan.completedExcluded}`);
    console.log('no worktrees created, no workers dispatched (dry-run).');
    process.exit(0);
  }

  // ---- LIVE RUN: preflight → resume reconcile → runFleet ----
  runLive({ repo: process.cwd(), dir, all, config, onlyIds }).then((code) => process.exit(code));
}

if (!['run', 'status', 'unlock'].includes(sub)) {
  gateFail(`unknown subcommand: ${sub}\n\n${USAGE}`);
}

async function runLive({ repo, dir, all, config, onlyIds }) {
  const io = defaultIo();
  const repoGit = io.git(repo);

  // Preflight (spec §8.0): resolve+require sandbox, lock, clean tree, rail-hook
  // probe, canary, merge-forecast. A failed canary aborts before real dispatch.
  const railHookInstalled = () => {
    try { execFileSync('bash', ['-lc', 'test -f "$HOME/.claude/plugins/cache/adlc/adlc"/*/hooks/adlc-hook.mjs 2>/dev/null || command -v adlc >/dev/null'], { stdio: 'ignore' }); return true; }
    catch { return false; }
  };
  // Canary (spec §8.0(b) / premortem F1): prove the sandbox execution plumbing on
  // a trivial command in a throwaway dir BEFORE dispatching real tickets, so a
  // broken sandbox aborts cheaply instead of failing every ticket.
  const dispatchCanary = async ({ sandboxSpec }) => {
    let tmp;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'fleet-canary-'));
      mkdirSync(join(tmp, '.home'), { recursive: true }); // bwrap bind source must exist (L4)
      const sb = new Sandbox({
        mode: sandboxSpec.mode, backend: sandboxSpec.backend, worktree: tmp, syntheticHome: join(tmp, '.home'),
        exec: async (argv, opts) => { const r = await io.spawnWorker(argv[0], argv.slice(1), { cwd: tmp, ...opts }); if (r.error) throw r.error; if (typeof r.status === 'number' && r.status !== 0) throw new Error(r.stderr || 'canary command failed'); return `${r.stdout ?? ''}`; },
      });
      const out = await sb.run(['/bin/sh', '-c', 'echo __fleet_canary_ok__'], { env: repoCommandEnv(io.env, { syntheticHome: join(tmp, '.home') }) });
      return { ok: String(out).includes('__fleet_canary_ok__'), output: String(out) };
    } catch (e) { return { ok: false, output: e.message }; }
    finally { if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
  };

  const pre = await runPreflight({
    repo, config, statusDir: dir, io,
    self: selfIdentity(), probes: lockProbes(),
    railHookInstalled,
    dispatchCanary: config.canary === false ? undefined : dispatchCanary,
  });
  for (const w of pre.warnings) console.error(`warning: ${w}`);
  if (!pre.ok) { console.error(`preflight failed: ${pre.reason}`); return pre.exitCode ?? 1; }

  try {
    // Resume reconcile (spec §6.4): if a prior status exists, classify merged
    // work by integration-branch ancestry; refuse on missing/moved anchors; and
    // CONTINUE that run (reuse its runId/integration branch/reconciled status)
    // rather than starting fresh (adversarial-review L3).
    const prior = loadStatus(dir);
    let resume;
    if (prior) {
      const rec = reconcileRun({ all, status: prior, repo, io });
      if (rec.refused) { console.error(`cannot resume: ${rec.reason}`); return 1; }
      if (rec.resume) { resume = { status: rec.status, integrationBranch: rec.status.integrationBranch }; console.error(`resuming run ${rec.status.runId} on ${rec.status.integrationBranch}`); }
    }

    const runId = resume ? resume.status.runId : `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
    const baseSha = resume ? resume.status.baseSha : repoGit('rev-parse', config.base);
    const deps = buildLiveDeps({ repo, config, statusDir: dir, sandboxSpec: pre.sandboxSpec, io });
    const summary = await runFleet({
      all, runId, resume,
      config: { ...config, baseSha, sandboxMode: pre.sandboxSpec.mode, onlyIds, startedAt: new Date().toISOString() },
      deps,
    });

    const states = Object.values(summary.results);
    const failed = states.filter((s) => s === 'failed' || s === 'blocked').length;
    console.log(`\nfleet run ${runId}: ${summary.merged} merged, ${failed} failed/blocked → ${summary.integrationBranch}` +
      `${summary.prCount ? ' (PR opened)' : ''}`);
    return failed > 0 ? 2 : 0;
  } finally {
    releaseLock(dir); // always release the preflight-held lock
  }
}
