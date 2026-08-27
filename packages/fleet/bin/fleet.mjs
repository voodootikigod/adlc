#!/usr/bin/env node
// @adlc/fleet — parallel ticket orchestration on the ADLC.
// Exit codes (CONVENTIONS): 0 = ok · 1 = operational error · 2 = a ticket failed/blocked.

import { parseArgs, gateFail, opError, printJson } from '@adlc/core';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadPlan, activeTickets } from '../lib/plan.mjs';
import { planRound } from '../lib/scheduler.mjs';
import { loadConfig, resolveRunConfig } from '../lib/config.mjs';
import { loadStatus } from '../lib/status.mjs';
import { readLockOwner, forceUnlock, releaseLock } from '../lib/lock.mjs';
import { runPreflight } from '../lib/preflight.mjs';
import { reconcileRun } from '../lib/resume.mjs';
import { buildLiveDeps, defaultIo } from '../lib/live-deps.mjs';
import { runFleet, runExitCode, failedBlockedCount } from '../lib/run.mjs';
import { selfIdentity, lockProbes } from '../lib/proc.mjs';
import {
  assertAdapterCanForceModel,
  assertNoArgvOverride,
  planSeats,
  previewArgv,
  quartermasterEngaged,
} from '../lib/quartermaster.mjs';
import { builderPrompt } from '../lib/charters.mjs';
import { getAdapter } from '../lib/adapters/index.mjs';
import { Sandbox } from '../lib/sandbox.mjs';
import { repoCommandEnv } from '../lib/env-scrub.mjs';

const USAGE = `fleet — parallel ADLC ticket orchestration

Usage:
  fleet run [--concurrency N] [--dry-run] [--tickets T1,T2] [--base B] [--json]
            [--adapter NAME] [--model MODEL] [--model-auth-key ENV_VAR]
            [--i-am-in-a-disposable-container] [--model-plane-writable PATH]
  fleet status [--json]
  fleet unlock

Exit codes: 0 ok · 1 operational error · 2 a ticket failed/blocked.`;

// Exported so a test can observe that a REPEATABLE flag actually accumulates.
// `multiple: false` does not error on a repeated flag — it silently keeps the last
// value — so the only way to see the difference is the parsed result itself.
export function parseFlags(args) {
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
      model: { type: 'string' },
      'model-auth-key': { type: 'string' },
      'adapter-command': { type: 'string' },
      'adapter-args': { type: 'string' },
      'model-plane-writable': { type: 'string', multiple: true },
    },
    allowPositionals: true,
  });
  return values;
}

function runCli() {
const raw = process.argv.slice(2);
const sub = raw[0];

if (!sub || sub === '--help' || sub === '-h') {
  console.log(USAGE);
  process.exit(0);
}

const dir = join(process.cwd(), '.adlc');

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
    model: flags.model,
    modelAuthKey: flags['model-auth-key'],
    // Operator-local worker binary override (A2) — CLI only, never repo config.
    adapterCommand: flags['adapter-command'] ?? undefined,
    adapterArgs: flags['adapter-args'] ? flags['adapter-args'].split(',') : undefined,
    // Operator-local escape hatch for the model-plane write boundary (#395): a
    // harness whose state directory the adapter catalog has not caught up with.
    modelPlaneWritable: flags['model-plane-writable'] ?? undefined,
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
    // Quartermaster planning runs for BOTH output modes, BEFORE either exits.
    //
    // `--json` is the format automation uses as a pre-dispatch check, so it must
    // be the stricter one, never the laxer: exiting here with the legacy plan
    // would report success for a registry that is malformed, missing, relative,
    // or in-repo, and the failure would surface only in the live run. The plan is
    // async (the adapter renders its own argv), so the exit MUST happen inside
    // the continuation — and the live run sits in an `else`, or the dry-run
    // would fall through into a real dispatch while the plan was still printing.
    // Route from the FULL store (CPM float is a whole-graph property, and the
    // completion-aware filter must see the tombstones to drop edges pointing at
    // them), then report only the selected subset. Passing a pre-filtered list
    // here would make `--tickets` change the channels the dry-run predicts, and
    // would crash on any edge targeting a completed ticket.
    buildQuartermasterPlan({ repo: process.cwd(), dir, tickets: all, onlyIds, config }).then((quartermaster) => {
      if (flags.json) { printJson({ ...plan, quartermaster }); process.exit(0); }
      console.log(`fleet dry-run — integration branch ${plan.integrationBranch}, concurrency ${cap}, base ${config.base}`);
      console.log(`  ready now (${plan.readyNow.length}): ${plan.readyNow.join(', ') || '(none)'}`);
      console.log(`  first batch (cap ${cap}): ${plan.firstBatch.join(', ') || '(none)'}`);
      console.log(`  waiting on deps (${plan.waitingOnDeps.length}): ${plan.waitingOnDeps.join(', ') || '(none)'}`);
      if (plan.subsetBlocked.length) console.log(`  subset-blocked: ${plan.subsetBlocked.join(', ')}`);
      console.log(`  completed (excluded): ${plan.completedExcluded}`);
      printQuartermasterPlan(quartermaster);
      console.log('no worktrees created, no workers dispatched (dry-run).');
      process.exit(0);
    });
  } else {
    // ---- LIVE RUN: preflight → resume reconcile → runFleet ----
    runLive({ repo: process.cwd(), dir, all, config, onlyIds }).then((code) => process.exit(code));
  }
}

if (!['run', 'status', 'unlock'].includes(sub)) {
  gateFail(`unknown subcommand: ${sub}\n\n${USAGE}`);
}
}

// The file:// URL of the script Node was started with, symlinks resolved — npm's
// .bin entries are symlinks, so argv[1] is the link while import.meta.url is the
// real file (#786) — or null when there is no resolvable entry: a bare `node -e`
// import has no argv[1], and a nonexistent argv[1] cannot be realpath'd.
function entryUrl() {
  if (!process.argv[1]) return null;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return null;
  }
}

// Dispatch the CLI ONLY when run as the entry point. Importing this module (e.g. a unit
// test importing runLive) must not parse argv, hit process.exit, or gateFail.
if (entryUrl() === import.meta.url) runCli();

// Collaborators are injectable (defaulting to the real implementations) purely for
// testability: the production call site passes no overrides, so behavior is unchanged, but a
// unit test can drive the preflight / run / exit-code path without a real sandbox.
/**
 * Print what the operator-local registry WOULD dispatch, without dispatching.
 *
 * The argv comes from the adapter's own `dispatch` under a capture-only exec, so
 * the dry-run cannot claim one command line while the live run uses another. The
 * prompt is elided for readability; every other argument is verbatim.
 */
async function buildQuartermasterPlan({ repo, dir, tickets, onlyIds, config }) {
  if (!quartermasterEngaged({ env: process.env, repoDir: repo })) {
    // Legacy dispatch: no registry to validate the seat, so the dry-run owes the
    // operator the same two checks the live path makes — or it would approve a
    // configuration the live run then rejects, which is the dry-run/live
    // divergence this layer exists to remove.
    try {
      // (a) the harness exists at all. `buildLiveDeps` resolves it eagerly on
      //     this path (fleet AC4), so a dry-run that skipped it would green-light
      //     a typo'd --adapter that aborts the real run at assembly.
      getAdapter(config.adapter ?? 'claude-code');
      // (b) --model is not silently dropped by an adapter that cannot carry it.
      assertAdapterCanForceModel({ adapter: config.adapter, model: config.model, adapterArgs: config.adapterArgs });
    } catch (e) {
      opError(`fleet: ${e.message}`);
    }
    return { engaged: false, seats: [] };
  }

  let planned;
  try {
    assertNoArgvOverride(config);
    planned = planSeats({ tickets, onlyIds, repoDir: repo, env: process.env, adlcDir: dir });
  } catch (e) {
    for (const n of e.notices ?? []) console.error(`notice: ${n}`);
    opError(`quartermaster: ${e.message}`); // exits 1 — fail closed, no fallback channel
  }
  for (const n of planned.notices) console.error(`notice: ${n}`);

  const seats = [];
  for (const ticket of tickets) {
    const entry = planned.seats.get(ticket.id);
    if (!entry) continue;
    const { job, route, seat } = entry;
    const prompt = builderPrompt(ticket, config.gate);
    const argv = await previewArgv({ seat, prompt });
    seats.push({
      id: ticket.id,
      job,
      channel: route.channel,
      adapter: seat.adapter,
      model: seat.model,
      transport: seat.transport,
      provider: seat.provider,
      // F8 escalation (#401): a ladder-start seat is a STARTING point, and a
      // plan that printed only it would imply one fixed model for the whole
      // ticket. The rungs a retry may climb to are part of what this run may
      // spend, so they belong in the plan the operator approves.
      escalation: (entry.escalation ?? []).map((rung) => ({
        channel: rung.channel,
        adapter: rung.seat.adapter,
        model: rung.seat.model,
        transport: rung.seat.transport,
      })),
      // The prompt is elided so the plan stays readable; every other argument is
      // verbatim, straight from the adapter's own dispatch.
      argv: { command: argv.cmd, args: argv.args.map((a) => (a === prompt ? '<prompt>' : a)) },
    });
  }
  return { engaged: true, registryPath: planned.registryPath, notices: planned.notices, seats };
}

/** Render a built quartermaster plan for the human-readable dry run. */
function printQuartermasterPlan(quartermaster) {
  if (!quartermaster.engaged) {
    console.log('  quartermaster: not engaged (no operator-local registry) — dispatch uses --adapter / --model.');
    return;
  }
  console.log(`  quartermaster registry: ${quartermaster.registryPath}`);
  for (const seat of quartermaster.seats) {
    console.log(
      `  ${seat.id.padEnd(8)} job=${seat.job} channel=${seat.channel} adapter=${seat.adapter} ` +
        `model=${seat.model} transport=${seat.transport}`
    );
    console.log(`           argv: ${seat.argv.command} ${JSON.stringify(seat.argv.args)}`);
    // Printed only when the ladder can actually climb, so a direct-mode seat
    // still reads as the single fixed model it is.
    if (seat.escalation?.length > 0) {
      const rungs = seat.escalation.map((r) => `${r.channel} (${r.adapter} ${r.model})`).join(' → ');
      console.log(`           escalates on retry: ${rungs}`);
    }
  }
}

export async function runLive({ repo, dir, all, config, onlyIds }, {
  io = defaultIo(),
  preflight = runPreflight,
  build = buildLiveDeps,
  run = runFleet,
  loadPrior = loadStatus,
  reconcile = reconcileRun,
  release = releaseLock,
} = {}) {
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

  const pre = await preflight({
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
    const prior = loadPrior(dir);
    let resume;
    if (prior) {
      const rec = reconcile({ all, status: prior, repo, io });
      if (rec.refused) { console.error(`cannot resume: ${rec.reason}`); return 1; }
      if (rec.resume) { resume = { status: rec.status, integrationBranch: rec.status.integrationBranch }; console.error(`resuming run ${rec.status.runId} on ${rec.status.integrationBranch}`); }
    }

    const runId = resume ? resume.status.runId : `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
    const baseSha = resume ? resume.status.baseSha : repoGit('rev-parse', config.base);
    // Quartermaster (operating-stack §4c, §5): resolve every ticket's seat from
    // the operator-local registry BEFORE any worker is dispatched. Fail closed —
    // a disabled path or an invalid registry aborts the run rather than falling
    // back to a channel nobody authorized.
    let seats;
    if (quartermasterEngaged({ env: io.env, repoDir: repo })) {
      try {
        assertNoArgvOverride(config);
        const planned = planSeats({ tickets: all, repoDir: repo, env: io.env, adlcDir: dir });
        for (const n of planned.notices) console.error(`notice: ${n}`);
        console.error(`quartermaster: dispatching from ${planned.registryPath}`);
        seats = planned.seats;
      } catch (e) {
        for (const n of e.notices ?? []) console.error(`notice: ${n}`);
        console.error(`quartermaster: ${e.message}`);
        return 1;
      }
    } else {
      // Legacy dispatch — no registry seat to validate, but --model must still
      // not be silently discarded by an adapter that cannot carry it (§4c).
      try {
        assertAdapterCanForceModel({ adapter: config.adapter, model: config.model, adapterArgs: config.adapterArgs });
      } catch (e) {
        console.error(`fleet: ${e.message}`);
        return 1;
      }
    }

    const deps = build({ repo, config, statusDir: dir, sandboxSpec: pre.sandboxSpec, io, seats });
    const summary = await run({
      all, runId, resume,
      config: { ...config, baseSha, sandboxMode: pre.sandboxSpec.mode, onlyIds, startedAt: new Date().toISOString() },
      deps,
    });

    if (summary.contaminated) {
      console.error(`\nfleet run ${runId}: QUARANTINED — ${summary.contaminationReason}.` +
        ` Branch ${summary.integrationBranch} carries an ungated change and needs manual cleanup; no PR was opened.`);
    } else {
      const failed = failedBlockedCount(summary.results);
      console.log(`\nfleet run ${runId}: ${summary.merged} merged, ${failed} failed/blocked → ${summary.integrationBranch}` +
        `${summary.prCount ? ' (PR opened)' : ''}`);
    }
    // Exit code keys on quarantine FIRST — see runExitCode. A quarantined-no-work resume
    // must not report success just because no ticket reached a failed/blocked state.
    return runExitCode(summary);
  } finally {
    release(dir); // always release the preflight-held lock
  }
}
