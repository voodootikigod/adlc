// Live dependency assembly (spec §4, §6, §8, §9) — the concrete `deps` object
// runFleet consumes, composing the MVP's injected-seam modules with real git,
// sandbox, worker, gate, prosecution, and merge implementations. This is what
// makes `fleet run` execute end-to-end.
//
// Every low-level primitive (git, worker spawn, adlc CLI, file read, review
// runner) is reached through an `io` object with real defaults, so the whole
// assembly is unit-testable with stubs (AC1) and no live git/claude/model.

import { defaultGit } from './worktrees.mjs';
import * as worktrees from './worktrees.mjs';
import { Sandbox } from './sandbox.mjs';
import { repoCommandEnv, modelPlaneEnv } from './env-scrub.mjs';
import { runGatePipeline } from './gate-pipeline.mjs';
import { runGates, checkFlail, MAX_OUTPUT_BYTES } from './gates.mjs';
import { getAdapter } from './adapters/index.mjs';
import { prosecute as prosecuteGate } from './prosecute.mjs';
import { makeReviewRunner } from './review-runner.mjs';
import { builderPrompt, fixPrompt } from './charters.mjs';
import { PROTECTED_PREFIXES, isUnderProtectedPrefix } from './protected-paths.mjs';
import { BASE_MANIFEST } from './protected-paths.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { spawnAsync } from './spawn-async.mjs';
import { completeTicketOnIntegration, revertCompletionCommit, assertOnBranch } from './complete.mjs';

// Ignore fleet working state WITHOUT committing to the base checkout
// (adversarial-review L2). `.git/info/exclude` is a local, per-repo, UNcommitted
// ignore file — the fleet never writes base history.
function ensureLocalExclude(repoDir) {
  // In a LINKED git worktree `<repo>/.git` is a FILE, not a directory, so the
  // naive join silently failed into the catch below. That was harmless while
  // nothing created `.adlc/fleet-logs/` — but dispatch now does, and an
  // unexcluded untracked dir makes every subsequent run abort at preflight
  // with "main checkout has uncommitted changes", blaming the operator for a
  // file the fleet itself wrote.
  let gitDir;
  try {
    gitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoDir, encoding: 'utf8' }).trim();
  } catch { return; }
  if (!gitDir) return;
  const p = join(isAbsolute(gitDir) ? gitDir : join(repoDir, gitDir), 'info', 'exclude');
  const want = ['.worktrees/', '.adlc/fleet-status.json', '.adlc/fleet-logs/', '.adlc/fleet.lock/'];
  let cur = '';
  try { cur = existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return; }
  const lines = cur.split('\n');
  const missing = want.filter((l) => !lines.includes(l));
  if (missing.length) {
    try { appendFileSync(p, (cur.endsWith('\n') || cur === '' ? '' : '\n') + missing.join('\n') + '\n'); } catch { /* best effort */ }
  }
}

/**
 * The `exec` runner `checkFlail` uses in production (#284).
 *
 * EXPORTED so the contract tests can drive this exact function against the real
 * detector. A test that re-implements it inline would be a copy, and a copy
 * cannot catch drift in the thing it copies — which is the failure mode that
 * let #284 ship in the first place.
 *
 * `io.adlc` is spawnSync-shaped and does NOT throw on a non-zero exit, so the
 * exit code would otherwise be discarded and exit 1 (operational error) would
 * be indistinguishable from exit 2 (flail verdict). Converting a non-zero exit
 * into an execFileSync-shaped throw carrying `status` + `stdout` routes both
 * this path and `defaultExec` through checkFlail's single exit-code trust rule.
 */
export function flailExec(io) {
  return (bin, args) => {
    const r = io.adlc(args, { bin, maxBuffer: MAX_OUTPUT_BYTES });
    // Could not spawn at all, or no exit status to trust → unverifiable (§12).
    if (r?.error) throw r.error;
    if (typeof r?.status !== 'number') throw new Error('flail-detector did not run');
    if (r.status !== 0) {
      const e = new Error(`flail-detector exited ${r.status}`);
      e.status = r.status;
      e.stdout = r.stdout ?? '';
      throw e;
    }
    return r.stdout ?? '';
  };
}

/** Path of the accumulated worker transcript flail-detector analyzes. */
export function fleetLogPath(statusDir, repo, ticketId) {
  return join(statusDir ?? join(repo, '.adlc'), 'fleet-logs', `${ticketId}.log`);
}

export function defaultIo() {
  return {
    git: (dir) => defaultGit(dir),
    // Sync adlc for the quick, off-hot-path calls (flail between strikes;
    // best-effort gate-manifest recording). The per-ticket rails-guard on the
    // gate path uses adlcAsync so it does not block the event loop (#164).
    // `bin` lets a caller honor an operator-configured `config.adlcBin` instead
    // of always resolving the bare name from PATH; it is stripped before the
    // rest of the options reach spawnSync.
    adlc: (args, opts = {}) => {
      const { bin = 'adlc', ...rest } = opts;
      return spawnSync(bin, args, { encoding: 'utf8', ...rest });
    },
    adlcAsync: (args, opts = {}) => spawnAsync('adlc', args, { encoding: 'utf8', ...opts }),
    // Async (non-blocking) worker/gate/review execution so the concurrent
    // scheduler is not serialized by a blocking spawn (#164).
    spawnWorker: (cmd, args, opts) => spawnAsync(cmd, args, { encoding: 'utf8', ...opts }),
    readFile: (p) => readFileSync(p, 'utf8'),
    exists: (p) => existsSync(p),
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    writeJson: (p, obj) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); },
    // Best-effort: losing a transcript line must never fail a build. A missing
    // log degrades the flail check to its documented fail-open, nothing worse.
    // `reset` truncates instead of appending — see the strike-1 call site.
    appendLog: (p, text, { reset = false } = {}) => {
      try {
        mkdirSync(dirname(p), { recursive: true });
        if (reset) writeFileSync(p, text); else appendFileSync(p, text);
      } catch { /* best effort */ }
    },
    ensureGitignore: (repoDir) => ensureLocalExclude(repoDir),
    env: process.env,
    hasGh: () => { try { execFileSync('gh', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } },
  };
}

const PROSECUTE_GATED_MANIFEST = BASE_MANIFEST;

/** Parse `git status --porcelain --ignored -uall` output to worktree paths. */
function parseStatusPaths(out) {
  return String(out || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/**
 * Build the real deps for runFleet.
 *
 * @param sandboxSpec { mode, backend } resolved by preflight (spec §7.3)
 * @param reviewRunner optional override; defaults to the real adversarial-review runner
 */
export function buildLiveDeps({ repo, config, statusDir, sandboxSpec, reviewRunner, seats, io = defaultIo() }) {
  const repoGit = io.git(repo);
  // EVERY integration-branch operation runs in the run's dedicated worktree, never in
  // the shared main checkout. The path is deterministic so it resolves identically on
  // a resume, before createIntegrationBranch has run.
  const integrationPath = join(repo, worktrees.INTEGRATION_WORKTREE);
  const integrationGit = io.git(integrationPath);
  // Resolve the configured worker harness (T44), fail-closed on an unknown name
  // — but ONLY when it is actually the thing that will run.
  //
  // With a registry engaged every ticket takes its adapter from a seat and
  // `config.adapter` is never consulted, so validating it there made a stale
  // `--adapter` abort live assembly over a value the run would never use, while
  // the dry-run (which previews only seat adapters) reported success. That
  // divergence is precisely what this layer exists to remove.
  //
  // The eager check is KEPT for the legacy path, because AC4 requires an unknown
  // adapter to fail at assembly rather than at first dispatch — deferring it
  // would trade a clear abort for a mid-run failure.
  const seatsPresent = seats instanceof Map ? seats.size > 0 : false;
  const legacyAdapter = seatsPresent ? null : getAdapter(config.adapter ?? 'claude-code');

  // Quartermaster seats (operating-stack §4c, §5): when the operator has a
  // registry, the harness AND the model are per-ticket registry data, not a
  // single run-wide flag. `seats` is absent when the layer is not engaged, and
  // dispatch keeps its pre-quartermaster behavior.
  const seatFor = (ticket) => seats?.get(ticket?.id)?.seat ?? null;
  const adapterFor = (ticket) => {
    const seat = seatFor(ticket);
    if (seat) return getAdapter(seat.adapter);
    if (!legacyAdapter) {
      // Seats were present at assembly but this ticket has none — it was never
      // routed. Falling back to `config.adapter` would dispatch it on supply the
      // registry did not authorize, so refuse.
      throw new Error(
        `fleet: no quartermaster seat for ticket ${ticket?.id ?? '(unknown)'}, and an engaged registry supersedes ` +
          '--adapter. Refusing to dispatch on unauthorized supply.'
      );
    }
    return legacyAdapter;
  };
  const review = reviewRunner ?? makeReviewRunner({
    reviewBin: config.reviewBin ?? 'adversarial-review',
    provider: config.reviewProvider,
    failOn: config.prosecuteFailOn,
  });
  const adlcBin = config.adlcBin ?? 'adlc';

  // A per-worktree Sandbox on the repo-command plane (§7.3). exec runs the
  // wrapped argv via the worker-spawn primitive so tests can observe it.
  const sandboxFor = (worktree) => new Sandbox({
    mode: sandboxSpec.mode,
    backend: sandboxSpec.backend,
    worktree,
    syntheticHome: join(worktree, '.fleet-home'),
    exec: async (argv, opts) => {
      // The synthetic HOME is a bind SOURCE for bwrap — it must exist before the
      // wrapped command runs, or bwrap aborts (adversarial-review L4).
      io.mkdirp(join(worktree, '.fleet-home'));
      const res = await io.spawnWorker(argv[0], argv.slice(1), { cwd: worktree, ...opts });
      if (res.error) throw res.error;
      if (typeof res.status === 'number' && res.status !== 0) {
        const e = new Error(`command failed (exit ${res.status})`);
        e.stdout = res.stdout; e.stderr = res.stderr; throw e;
      }
      return `${res.stdout ?? ''}`;
    },
  });

  const repoCmdEnv = (worktree) => repoCommandEnv(io.env, {
    passthrough: config.envPassthrough ?? [],
    syntheticHome: join(worktree, '.fleet-home'),
  });

  return {
    statusDir,

    createIntegrationBranch: ({ integrationBranch, baseSha }) => {
      io.ensureGitignore(repo, repoGit);
      // Create the branch AND its dedicated worktree in one step. From here on the
      // integration branch is checked out ONLY there — git will refuse to check it out
      // in the shared main checkout, so the whole class of "another process moved HEAD
      // under us" becomes impossible instead of merely detectable.
      worktrees.ensureIntegrationWorktree(repo, integrationBranch, { baseSha, git: repoGit, gitAt: io.git });
    },

    // Resume counterpart: re-attach the dedicated worktree to an EXISTING integration
    // branch (no baseSha — the branch and its history must be preserved).
    ensureIntegrationWorktree: ({ integrationBranch }) => {
      io.ensureGitignore(repo, repoGit);
      worktrees.ensureIntegrationWorktree(repo, integrationBranch, { git: repoGit, gitAt: io.git });
    },

    createWorktree: async ({ ticket, integrationBranch }) => {
      const wt = worktrees.createWorktree(repo, ticket.id, { integrationBranch, git: repoGit });
      // Initialize the worktree THROUGH the sandbox (§6.3, M1) — repo-config init
      // (npm install) runs arbitrary lifecycle code and must be contained.
      if (config.init) {
        try { await sandboxFor(wt.path).run(['/bin/sh', '-c', config.init], { env: repoCmdEnv(wt.path) }); }
        catch (e) { throw new Error(`worktree init failed for ${ticket.id}: ${e.message}`); }
      }
      return wt;
    },

    // provision is OPTIONAL per the WorkerAdapter contract (§4): only claude-code
    // writes a settings file; codex/agy/opencode/pi/cursor have none (adversarial-review A1).
    provision: ({ ticket, worktree }) => adapterFor(ticket).provision?.({ worktree, config, writeJson: io.writeJson }),

    dispatch: async ({ ticket, worktree, strike, deadEnds = [] }) => {
      const prompt = strike > 1 ? fixPrompt(ticket, config.gate, deadEnds) : builderPrompt(ticket, config.gate);
      const env = modelPlaneEnv(io.env, {
        modelAuthKey: config.modelAuthKey,
        extra: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: ticket.id },
      });
      const seat = seatFor(ticket);
      const res = await adapterFor(ticket).dispatch({
        worktree, prompt, timeoutMs: (config.timeoutMinutes ?? 30) * 60000, env,
        exec: (cmd, args, opts) => io.spawnWorker(cmd, args, opts),
        // Operator-local binary override (A2) + non-executable data from config.
        command: config.adapterCommand ?? undefined,
        args: config.adapterArgs ?? undefined,
        // §4c force half: the registry's model goes onto the command line
        // explicitly, never the harness's ambient default. A seat always wins
        // over `fleet.model` — the whole point of the registry is that supply is
        // decided by the operator's file, not by run config.
        model: seat ? seat.model : (config.model ?? undefined),
        useStdin: config.adapterStdin === true, // pi RPC/stdin prompt transport (A3)
      });
      // Persist the transcript BEFORE anything can return early, so the flail
      // consultation between strikes has something to analyze. Without this the
      // detector is handed a nonexistent path, exits 1, and every consultation
      // fails open — #284's fix is inert without it.
      //
      // Strike 1 TRUNCATES; later strikes append. The log accumulates across
      // the strikes of one run (checkFlail is documented to analyze the
      // accumulated log) but must never carry across runs: the file is
      // git-excluded and listed in INERT_GLOBS, so nothing else ever deletes
      // it, and the detector's repeated-error threshold is only 2. A ticket
      // re-run or resumed after a failure would otherwise be judged on the
      // PREVIOUS run's errors and killed on the first strike it has taken —
      // a fail-closed misfire caused purely by stale state.
      const logPath = fleetLogPath(statusDir, repo, ticket.id);
      let reset = strike === 1; // only the first write of strike 1 truncates
      const write = (text) => { io.appendLog(logPath, text, { reset }); reset = false; };
      write(`=== ${ticket.id} strike ${strike} ===\n${res.output ?? ''}\n`);
      // Commit the worker's changes (orchestrator commits; §6.3 pathspec excludes control dirs).
      if (res.exitCode === 0 && !res.timedOut && !/TICKET-BLOCKED/.test(res.output)) {
        try { worktrees.commitWorker(worktree, ticket.id, io.git(worktree)); }
        catch (e) {
          // This IS the failure the scheduler will act on, so it belongs in the
          // transcript the flail check analyzes — otherwise a commit failure
          // repeating across strikes can never reach the repeated-error signal.
          const output = `${res.output}\ncommit failed: ${e.message}`;
          write(`commit failed: ${e.message}\n`);
          return { exitCode: 1, output, timedOut: false };
        }
      }
      return { ...res, blocked: /TICKET-BLOCKED/.test(res.output) };
    },

    gate: ({ ticket, worktree, startSha }) => {
      const wtGit = io.git(worktree);
      const changedPaths = wtGit('diff', '--name-only', `${startSha}..HEAD`).split('\n').map((s) => s.trim()).filter(Boolean);
      // Authoritative templates = the startSha-committed version of each manifest file.
      const templates = new Map();
      for (const p of PROSECUTE_GATED_MANIFEST) {
        try { templates.set(p, wtGit('show', `${startSha}:${p}`)); } catch { /* absent at startSha */ }
      }
      const listProtected = () => {
        const paths = parseStatusPaths(wtGit('status', '--porcelain', '--ignored', '--untracked-files=all'));
        return paths.filter((p) => isUnderProtectedPrefix(p));
      };
      const readBytes = (p) => (io.exists(join(worktree, p)) ? io.readFile(join(worktree, p)) : undefined);
      const railsGuard = async () => {
        const res = await io.adlcAsync(['rails-guard', '--base', startSha, '--ticket', ticket.id], { cwd: worktree });
        return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
      };
      return runGatePipeline(ticket, {
        sandbox: sandboxFor(worktree),
        gate: config.gate,
        env: repoCmdEnv(worktree),
        changedPaths,
        templates,
        listProtected,
        readBytes,
        railsGuard,
      });
    },

    prosecute: ({ ticket, worktree, startSha }) =>
      prosecuteGate({ worktree, startSha, ticket }, { runReview: review, failOn: config.prosecuteFailOn }),

    flail: ({ ticket }) => checkFlail(
      fleetLogPath(statusDir, repo, ticket.id),
      ticket.scope,
      { adlcBin, exec: flailExec(io) },
    ),

    // Rebase inside the ticket's own worktree, merge inside the integration worktree —
    // no checkout switching anywhere, and the shared checkout is never involved.
    mergeToIntegration: ({ branch, integrationBranch, worktree }) => worktrees.mergeToIntegration({
      branch,
      integrationBranch,
      ticketGit: io.git(worktree),
      integrationGit,
    }),

    postMergeGate: async ({ integrationBranch }) => {
      // Gate inside the integration worktree — no checkout, nothing shared. The branch
      // identity and SHA are pinned either side: the worktree removes the
      // external-interference class, and these assertions keep the verdict provably
      // attributable to the commit being approved (defence in depth, and they cost
      // two git calls).
      let gatedSha;
      try {
        assertOnBranch(integrationGit, integrationBranch, 'before gating', 'trust the gate');
        gatedSha = integrationGit('rev-parse', 'HEAD');
      } catch (error) {
        return { ok: false, output: `${error.message}; refusing to gate` };
      }
      // MUST await: runGates is async (it runs build/test to completion). Reading HEAD
      // before awaiting would pin it BEFORE the gate's commands ever ran, so a commit or
      // ref movement DURING the build/test would be invisible and a stale passing verdict
      // would be trusted (adversarial-review round-30). The whole point of the after-gate
      // pin is to observe the branch tip AS IT WAS while the gate executed.
      const result = await runGates(sandboxFor(integrationPath), config.gate, repoCmdEnv(integrationPath));
      try {
        assertOnBranch(integrationGit, integrationBranch, 'after gating', 'trust the gate');
        if (integrationGit('rev-parse', 'HEAD') !== gatedSha) {
          throw new Error(`refusing to trust the gate: HEAD moved from ${gatedSha} while the gate ran`);
        }
      } catch (error) {
        return { ok: false, output: `${error.message}; the gate result cannot be attributed to ${integrationBranch}` };
      }
      return result;
    },

    revertMerge: ({ integrationBranch, mergeSha, preMergeSha }) =>
      worktrees.revertMerge(integrationPath, integrationBranch, { mergeSha, preMergeSha }, integrationGit),

    // T73: after the post-merge gate passes, complete the ticket ON the integration
    // branch (checked out at `repo` by postMergeGate) via the same planComplete +
    // apply path the CLI uses, committing the add-only completed:true diff so it
    // rides the single PR. Idempotent and best-effort at the call site (§run.mjs).
    completeTicket: ({ ticket, integrationBranch }) =>
      completeTicketOnIntegration({ repo: integrationPath, ticketId: ticket.id, integrationBranch, git: integrationGit }),

    // Withdraw ONLY the completion commit when the gate re-run over it fails; the
    // shipped merge underneath is never touched.
    revertCompletion: ({ toSha, shardPath, completionSha, integrationBranch }) =>
      revertCompletionCommit({ repo: integrationPath, toSha, shardPath, completionSha, integrationBranch, git: integrationGit }),

    cleanup: ({ worktree, state }) => {
      // Keep failed worktrees for inspection; remove merged ones.
      if (state === 'merged') worktrees.removeWorktree(repo, worktree, repoGit);
      worktrees.pruneWorktrees(repo, repoGit);
    },

    // Best-effort evidence: never block the run on a recorder error (AC5).
    recordGate: ({ ticket, phase, ok }) => {
      try { io.adlc(['gate-manifest', 'record', phase, '--ticket', ticket.id, ok ? '--pass' : '--fail'], {}); }
      catch { /* evidence is best-effort */ }
    },

    openPR: async ({ integrationBranch, base }) => {
      if (!io.hasGh()) return { opened: false, reason: 'gh CLI not available' };
      try {
        integrationGit('push', '-u', 'origin', integrationBranch);
        // AWAIT the creation: spawnWorker is async, so a fire-and-forget call would
        // report success before `gh pr create` ran and could miss its failure entirely.
        const res = await io.spawnWorker('gh', ['pr', 'create', '--base', base, '--head', integrationBranch, '--fill'], { cwd: repo });
        if (res?.error) throw res.error;
        if (typeof res?.status === 'number' && res.status !== 0) {
          return { opened: false, reason: `gh pr create exited ${res.status}: ${(res.stderr ?? '').trim()}`.trim() };
        }
        return { opened: true };
      } catch (e) { return { opened: false, reason: e.message }; }
    },
  };
}

export { PROTECTED_PREFIXES };
