#!/usr/bin/env node
// @adlc/fleet — parallel ticket orchestration on the ADLC.
// Exit codes (CONVENTIONS): 0 = ok · 1 = operational error · 2 = a ticket failed/blocked/paused.

import { parseArgs, gateFail, opError, printJson } from '@adlc/core';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, realpathSync, readFileSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants as fsConstants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadPlan, activeTickets } from '../lib/plan.mjs';
import { planRound, REASON_CODES } from '../lib/scheduler.mjs';
import { loadConfig, resolveRunConfig, validateExtensionFlags, parsePreStrike } from '../lib/config.mjs';
import { loadStatus } from '../lib/status.mjs';
import { readLockOwner, forceUnlock, releaseLock } from '../lib/lock.mjs';
import { runPreflight } from '../lib/preflight.mjs';
import { reconcileRun } from '../lib/resume.mjs';
import { buildLiveDeps, defaultIo } from '../lib/live-deps.mjs';
import { runFleet, runExitCode, failedBlockedCount, pausedCount } from '../lib/run.mjs';
import { resultDocument, RUN_REASONS } from '../lib/result.mjs';
import { selfIdentity, lockProbes } from '../lib/proc.mjs';
import {
  assertAdapterCanForceModel,
  assertNoArgvOverride,
  planSeats,
  previewArgv,
  quartermasterEngaged,
} from '../lib/quartermaster.mjs';
import { builderPrompt, fenceDeadEnd } from '../lib/charters.mjs';
import { getAdapter } from '../lib/adapters/index.mjs';
import { Sandbox } from '../lib/sandbox.mjs';
import { repoCommandEnv } from '../lib/env-scrub.mjs';

const USAGE = `fleet — parallel ADLC ticket orchestration

Usage:
  fleet run [--concurrency N] [--dry-run] [--tickets T1,T2] [--base B] [--json]
            [--adapter NAME] [--model MODEL] [--model-auth-key ENV_VAR]
            [--i-am-in-a-disposable-container] [--model-plane-writable PATH]
            [--no-pr] [--no-complete] [--dead-end-file PATH] [--max-strikes N]
            [--wall-clock-minutes M] [--charter-file PATH]
            [--pre-strike-argv JSON_ARRAY --pre-strike-env JSON_OBJECT]
            [--model-plane-read host|bounded] [--model-plane-read-only ABS,ABS,...]
            [--model-plane-git shared|mirror] [--model-plane-git-mirror ABS_BARE_REPO]
            [--model-plane-egress open|allowlist] [--worker-deps ABS_NODE_MODULES]
  fleet status [--json]
  fleet unlock

Exit codes: 0 ok · 1 operational error · 2 a ticket failed/blocked/paused (see --json "reason").`;

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
      // ---- autopilot extensions (issue-autopilot-local §14), all operator-local ----
      'no-pr': { type: 'boolean' },
      'no-complete': { type: 'boolean' },
      'dead-end-file': { type: 'string' },
      'max-strikes': { type: 'string' },
      'wall-clock-minutes': { type: 'string' },
      'charter-file': { type: 'string' },
      'pre-strike-argv': { type: 'string' },
      'pre-strike-env': { type: 'string' },
      'model-plane-read': { type: 'string' },
      'model-plane-read-only': { type: 'string' },
      'model-plane-git': { type: 'string' },
      'model-plane-git-mirror': { type: 'string' },
      'model-plane-egress': { type: 'string' },
      'worker-deps': { type: 'string' },
    },
    allowPositionals: true,
  });
  return values;
}

/** Integer-or-undefined from a string flag; a non-numeric string becomes NaN so validation rejects it. */
function intFlag(v) {
  if (v == null) return undefined;
  return /^-?\d+$/.test(v) ? Number(v) : Number.NaN;
}

/**
 * Translate parsed flags into the operator-local overrides `resolveRunConfig`
 * accepts, validating the extension family (fleet-ext) BEFORE anything runs.
 * Throws on an invalid value; the CLI turns that into exit 1.
 */
export function extensionFlags(flags) {
  const preStrike = parsePreStrike({ argvJson: flags['pre-strike-argv'], envJson: flags['pre-strike-env'] });
  const ext = {
    noPr: flags['no-pr'] === true,
    noComplete: flags['no-complete'] === true,
    deadEndFile: flags['dead-end-file'] ?? undefined,
    maxStrikes: intFlag(flags['max-strikes']),
    wallClockMinutes: intFlag(flags['wall-clock-minutes']),
    charterFile: flags['charter-file'] ?? undefined,
    preStrikeArgv: preStrike.argv ?? undefined,
    preStrikeEnv: preStrike.env ?? undefined,
    modelPlaneRead: flags['model-plane-read'] ?? undefined,
    modelPlaneReadOnly: flags['model-plane-read-only'] ? flags['model-plane-read-only'].split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    modelPlaneGit: flags['model-plane-git'] ?? undefined,
    modelPlaneGitMirror: flags['model-plane-git-mirror'] ?? undefined,
    modelPlaneEgress: flags['model-plane-egress'] ?? undefined,
    workerDeps: flags['worker-deps'] ?? undefined,
  };
  validateExtensionFlags(ext);
  return ext;
}

// Under --json EVERY non-zero pre-dispatch exit carries one result document —
// refused flags, a failed ticket-store load, a dry-run/quartermaster refusal
// (codex r9/r10). Module scope: every refusal site, inside runCli or the
// quartermaster planner, reaches it.
function refuseFlags(message) {
  console.error(`fleet: ${message}`);
  if (process.argv.includes('--json')) printJson(resultDocument({ runId: null, exitCode: 1, summary: null, reason: RUN_REASONS.DISPATCH_REFUSED, sandbox: {}, warnings: [] }));
  process.exit(1);
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
  let flags;
  try { flags = parseFlags(raw.slice(1)); } catch (e) { refuseFlags(e.message); }
  let ext;
  try { ext = extensionFlags(flags); } catch (e) { refuseFlags(e.message); }
  const configResolved = resolveRunConfig(loadConfig(dir), {
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
    ...ext,
  });
  // A repo-configured concurrency can widen a mirror run past one worker: refuse it here too (codex r11).
  if (configResolved.modelPlaneGit === 'mirror' && configResolved.concurrency !== 1) refuseFlags('--model-plane-git mirror requires concurrency 1 (one writable mirror per worker)');
  const config = configResolved;
  for (const w of config.warnings) console.error(`warning: ${w}`);

  let ticketsFile;
  try {
    ticketsFile = loadPlan(join(dir, 'tickets.json'));
  } catch (e) {
    refuseFlags(`could not load .adlc/tickets.json: ${e.message}`);
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
      // The dry-run reports the resolved base SHA when the ref resolves, so a
      // caller pinning an OID can assert the plan is bound to it (autopilot §9.6).
      baseSha: resolveBaseSha(config.base),
      readyNow: admit.map((t) => t.id),
      firstBatch: admit.slice(0, cap).map((t) => t.id),
      waitingOnDeps: waiting.map((t) => t.id),
      subsetBlocked: blocked,
      completedExcluded: all.length - active.length,
      // fleet-ext item 10: the checkout the run is rooted in (cwd — a LINKED
      // worktree reads ITS OWN .adlc/ and cuts its worktrees under itself) and
      // the nested worktree paths the ready tickets would be cut at.
      worktreeRoot: process.cwd(),
      plannedWorktrees: Object.fromEntries(admit.map((t) => [t.id, join(process.cwd(), '.worktrees', `fleet-${t.id.toLowerCase()}`)])),
      integrationWorktree: join(process.cwd(), '.worktrees', 'fleet-integration'),
      // The effective operator-local policy, echoed so a caller can assert it
      // BEFORE a live dispatch (fleet-ext items 11–15).
      readPolicy: config.modelPlaneRead,
      privateTmp: config.modelPlaneRead === 'bounded',
      gitSource: config.modelPlaneGit,
      mirror: config.modelPlaneGitMirror,
      egress: config.modelPlaneEgress,
      workerDeps: config.workerDeps,
      maxStrikes: config.maxStrikes,
      wallClockMinutes: config.wallClockMinutes,
      noPr: config.noPr,
      noComplete: config.noComplete,
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
    runLive({ repo: process.cwd(), dir, all, config, onlyIds, json: flags.json === true })
      .then((code) => process.exit(code))
      .catch((e) => { console.error(`fleet: ${e?.stack ?? e?.message ?? e}`); if (flags.json === true) printJson(resultDocument({ runId: null, exitCode: 1, summary: null, reason: RUN_REASONS.DISPATCH_REFUSED, sandbox: {}, warnings: [] })); process.exit(1); });
  }
}

if (!['run', 'status', 'unlock'].includes(sub)) {
  gateFail(`unknown subcommand: ${sub}\n\n${USAGE}`);
}
}

/** `git rev-parse <base>` in the cwd, or null when the ref does not resolve (dry-run is advisory). */
function resolveBaseSha(base) {
  try { return execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
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
      refuseFlags(`fleet: ${e.message}`);
    }
    return { engaged: false, seats: [] };
  }

  let planned;
  try {
    assertNoArgvOverride(config);
    planned = planSeats({ tickets, onlyIds, repoDir: repo, env: process.env, adlcDir: dir });
  } catch (e) {
    for (const n of e.notices ?? []) console.error(`notice: ${n}`);
    refuseFlags(`quartermaster: ${e.message}`); // exits 1 — fail closed, no fallback channel
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

/**
 * Read the caller-supplied files an extension flag names (fleet-ext items 3, 6).
 * Returns { initialDeadEnds, charterAddendum } or throws with the offending path.
 */
/** Caller-supplied files are read only when they are REGULAR files no larger than this (a FIFO or a huge file would block or bloat the run) (codex r7). */
export const MAX_EXTENSION_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Read an operator file through ONE descriptor: open without following a symlink and without
 * blocking (a FIFO is refused, never waited on), fstat THAT descriptor (regular file, size within
 * the bound) and read at most the bound from it — no window between the check and the read
 * (codex r17 #1).
 */
export function readBoundedFile(path, max = MAX_EXTENSION_FILE_BYTES, { openSync: open = openSync, fstatSync: fstat = fstatSync, readSync: read = readSync, closeSync: close = closeSync } = {}) {
  const fd = open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const st = fstat(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > max) throw new Error(`${st.size} bytes exceeds ${max}`);
    const buf = Buffer.alloc(max + 1);
    let total = 0;
    for (;;) {
      const n = read(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > max) throw new Error(`more than ${max} bytes (the file grew while it was read)`);
      if (total === buf.length) break;
    }
    return buf.subarray(0, total).toString('utf8');
  } finally { try { close(fd); } catch { /* already closed */ } }
}

export function loadExtensionFiles(config, readFile = (p) => readBoundedFile(p)) {
  const out = { initialDeadEnds: [], charterAddendum: null };
  const checked = (flag, path) => {
    try { return readFile(path); } catch (e) { throw new Error(`${flag} ${path}: ${e.message}`); }
  };
  if (config.deadEndFile) out.initialDeadEnds = [fenceDeadEnd('PRIOR_ROUND', checked('--dead-end-file', config.deadEndFile))];
  if (config.charterFile) out.charterAddendum = checked('--charter-file', config.charterFile);
  return out;
}

/** The canary's timeout: the whole remaining budget, never padded; undefined without a deadline. */
export function canaryTimeout(deadline, nowMs) {
  return deadline == null ? undefined : Math.max(1, deadline - nowMs);
}

export async function runLive({ repo, dir, all, config, onlyIds, json = false }, {
  io = defaultIo(),
  preflight = runPreflight,
  build = buildLiveDeps,
  run = runFleet,
  loadPrior = loadStatus,
  reconcile = reconcileRun,
  release = releaseLock,
  now = Date.now,
  readFile,
  emit = printJson,
} = {}) {
  const repoGit = io.git(repo);
  // Human-readable lines go to stderr under --json so stdout carries exactly one document.
  const say = json ? (m) => console.error(m) : (m) => console.log(m);
  const finish = (code, { runId = null, summary = null, reason = null, sandbox = {}, warnings = [] } = {}) => {
    if (json) emit(resultDocument({ runId, exitCode: code, summary, reason, sandbox, warnings }));
    return code;
  };

  // fleet-ext item 5: the external wall clock is an absolute deadline anchored at
  // INVOCATION — before the caller-file reads, preflight, resume reconciliation and
  // planning — so every phase spends the same budget (codex r2, r7).
  const deadline = config.wallClockMinutes ? now() + config.wallClockMinutes * 60_000 : null;
  // Caller-supplied files (dead-end material, charter addendum) are read BEFORE
  // the lock is taken so a bad path never leaves a stale lock behind.
  let files;
  // The production reader is the bounded single-descriptor one (never the plain io.readFile) — codex r19 #2.
  try { files = loadExtensionFiles(config, readFile ?? undefined); }
  catch (e) { console.error(`fleet: ${e.message}`); return finish(1, { reason: RUN_REASONS.PREFLIGHT }); }

  // Preflight (spec §8.0): resolve+require sandbox, lock, clean tree, rail-hook
  // probe, canary, merge-forecast. A failed canary aborts before real dispatch.
  const railHookInstalled = () => {
    try { execFileSync('bash', ['-lc', 'test -f "$HOME/.claude/plugins/cache/adlc/adlc"/*/hooks/adlc-hook.mjs 2>/dev/null || command -v adlc >/dev/null'], { stdio: 'ignore' }); return true; }
    catch { return false; }
  };
  // Canary (spec §8.0(b) / premortem F1): prove the sandbox execution plumbing on
  // a trivial command in a throwaway dir BEFORE dispatching real tickets, so a
  // broken sandbox aborts cheaply instead of failing every ticket.
  // The canary is bounded by the run's remaining wall clock too (codex r3): a
  // hung sandbox must not outlive the advertised deadline before the first check.
  const canaryTimeoutMs = () => canaryTimeout(deadline, now());
  const dispatchCanary = async ({ sandboxSpec }) => {
    let tmp;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'fleet-canary-'));
      mkdirSync(join(tmp, '.home'), { recursive: true }); // bwrap bind source must exist (L4)
      const sb = new Sandbox({
        mode: sandboxSpec.mode, backend: sandboxSpec.backend, worktree: tmp, syntheticHome: join(tmp, '.home'),
        exec: async (argv, opts) => { const r = await io.spawnWorker(argv[0], argv.slice(1), { cwd: tmp, killGroup: true, ...opts }); if (r.error) throw r.error; if (typeof r.status === 'number' && r.status !== 0) throw new Error(r.stderr || 'canary command failed'); return `${r.stdout ?? ''}`; },
      });
      const out = await sb.run(['/bin/sh', '-c', 'echo __fleet_canary_ok__'], { env: repoCommandEnv(io.env, { syntheticHome: join(tmp, '.home') }), ...(canaryTimeoutMs() != null ? { timeout: canaryTimeoutMs() } : {}) });
      return { ok: String(out).includes('__fleet_canary_ok__'), output: String(out) };
    } catch (e) { return { ok: false, output: e.message }; }
    finally { if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
  };

  let pre;
  try {
    pre = await preflight({
      repo, config, statusDir: dir, io,
      self: selfIdentity(), probes: lockProbes(),
      railHookInstalled,
      dispatchCanary: config.canary === false ? undefined : dispatchCanary,
      remainingMs: deadline == null ? null : () => canaryTimeout(deadline, now()),
    });
  } catch (e) {
    // A THROWN preflight still yields the one document --json promised (codex r5);
    // the lock is released only if this process is the recorded owner.
    console.error(`preflight threw: ${e?.stack ?? e?.message ?? e}`);
    if (readLockOwner(dir)?.pid === process.pid) release(dir);
    return finish(1, { reason: RUN_REASONS.PREFLIGHT });
  }
  for (const w of pre.warnings) console.error(`warning: ${w}`);
  if (!pre.ok) {
    console.error(`preflight failed: ${pre.reason}`);
    return finish(pre.exitCode ?? 1, { reason: pre.reasonCode ?? RUN_REASONS.PREFLIGHT, warnings: pre.warnings });
  }
  // A preflight that consumed the whole budget ends the run here: nothing is
  // reconciled, planned or dispatched past the deadline (codex r3).
  if (deadline != null && now() >= deadline) {
    console.error('wall clock expired during preflight; nothing dispatched');
    release(dir); // the preflight-held lock must not outlive this early exit (codex r4)
    return finish(2, { reason: REASON_CODES.WALL_CLOCK, warnings: pre.warnings });
  }

  try {
    // Resume reconcile (spec §6.4): if a prior status exists, classify merged
    // work by integration-branch ancestry; refuse on missing/moved anchors; and
    // CONTINUE that run (reuse its runId/integration branch/reconciled status)
    // rather than starting fresh (adversarial-review L3).
    const prior = loadPrior(dir);
    let resume;
    if (prior) {
      const rec = reconcile({ all, status: prior, repo, io });
      if (rec.refused) { console.error(`cannot resume: ${rec.reason}`); return finish(1, { runId: prior.runId ?? null, reason: RUN_REASONS.RESUME_REFUSED }); }
      if (rec.resume) { resume = { status: rec.status, integrationBranch: rec.status.integrationBranch }; console.error(`resuming run ${rec.status.runId} on ${rec.status.integrationBranch}`); }
    }

    const runId = resume ? resume.status.runId : `${new Date(now()).toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
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
        return finish(1, { runId, reason: RUN_REASONS.DISPATCH_REFUSED });
      }
    } else {
      // Legacy dispatch — no registry seat to validate, but --model must still
      // not be silently discarded by an adapter that cannot carry it (§4c).
      try {
        assertAdapterCanForceModel({ adapter: config.adapter, model: config.model, adapterArgs: config.adapterArgs });
      } catch (e) {
        console.error(`fleet: ${e.message}`);
        return finish(1, { runId, reason: RUN_REASONS.DISPATCH_REFUSED });
      }
    }

    // fleet-ext item 5: `deadline` was computed ONCE at invocation (above), so
    // preflight, every dispatch, gate and the scheduler agree on the instant.
    const runConfig = {
      ...config, baseSha, sandboxMode: pre.sandboxSpec.mode, onlyIds, startedAt: new Date(now()).toISOString(),
      deadline, initialDeadEnds: files.initialDeadEnds, charterAddendum: files.charterAddendum,
    };
    let deps;
    try {
      deps = build({ repo, config: runConfig, statusDir: dir, sandboxSpec: pre.sandboxSpec, io, seats });
    } catch (e) {
      console.error(`fleet: ${e.message}`);
      return finish(1, { runId, reason: RUN_REASONS.DISPATCH_REFUSED });
    }
    let summary;
    try {
      summary = await run({ all, runId, resume, config: runConfig, deps: { ...deps, now } });
    } catch (e) {
      // A rejected pipeline (worktree creation, init, resume attachment) must still
      // yield the ONE result document a --json caller was promised, with a reason.
      console.error(`fleet run ${runId} failed: ${e?.stack ?? e?.message ?? e}`);
      return finish(1, { runId, reason: RUN_REASONS.DISPATCH_REFUSED, warnings: pre.warnings });
    }

    if (summary.contaminated) {
      say(`\nfleet run ${runId}: QUARANTINED — ${summary.contaminationReason}.` +
        ` Branch ${summary.integrationBranch} carries an ungated change and needs manual cleanup; no PR was opened.`);
    } else {
      const failed = failedBlockedCount(summary.results);
      const paused = pausedCount(summary.results);
      say(`\nfleet run ${runId}: ${summary.merged} merged, ${failed} failed/blocked${paused ? `, ${paused} paused` : ''} → ${summary.integrationBranch}` +
        `${summary.prCount ? ' (PR opened)' : ''}${summary.wallClockExpired ? ' (wall clock expired — resumable)' : ''}`);
    }
    // Exit code keys on quarantine FIRST — see runExitCode. A quarantined-no-work resume
    // must not report success just because no ticket reached a failed/blocked state.
    return finish(runExitCode(summary), { runId, summary, sandbox: deps.describeSandbox?.() ?? {}, warnings: pre.warnings });
  } catch (e) {
    // Resume reconciliation, base resolution or planning threw: one document, reason dispatch-refused.
    console.error(`fleet: ${e?.stack ?? e?.message ?? e}`);
    return finish(1, { reason: RUN_REASONS.DISPATCH_REFUSED, warnings: pre.warnings });
  } finally {
    release(dir); // always release the preflight-held lock
  }
}
