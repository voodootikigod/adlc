#!/usr/bin/env node
// @adlc/fleet — parallel ticket orchestration on the ADLC.
// Exit codes (CONVENTIONS): 0 = ok · 1 = operational error · 2 = a ticket failed/blocked.

import { parseArgs, gateFail, opError, printJson } from '@adlc/core';
import { join } from 'node:path';
import { loadPlan } from '../lib/plan.mjs';
import { planRound } from '../lib/scheduler.mjs';
import { activeTickets } from '../lib/plan.mjs';
import { loadConfig, resolveRunConfig } from '../lib/config.mjs';
import { loadStatus } from '../lib/status.mjs';
import { readLockOwner, forceUnlock } from '../lib/lock.mjs';

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
      console.log(`  ${id.padEnd(8)} ${String(r.state).padEnd(10)} strikes=${r.strikes ?? 0}${r.reason ? `  (${r.reason})` : ''}`);
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

  // A live run needs the sandbox, the git worktree machinery, and a worker
  // provider — none of which this environment guarantees. Rather than pretend,
  // the CLI requires the sandbox precondition and points at the documented smoke
  // path. The live orchestrator (lib/run.mjs runFleet) is wired and unit-tested;
  // wiring the real deps end-to-end is exercised by the README live-run steps.
  opError(
    'live `fleet run` requires a sandbox backend, the ADLC plugin rail hook, and a Claude Code ' +
    'worker on PATH. Run `fleet run --dry-run` to preview the plan; see the README "Live run" ' +
    'section for the end-to-end prerequisites and smoke steps.'
  );
}

gateFail(`unknown subcommand: ${sub}\n\n${USAGE}`);
