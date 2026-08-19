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
import { Sandbox, NETWORK, READ_POLICY } from './sandbox.mjs';
import { modelPlaneFilesystem } from './model-plane.mjs';
import { repoCommandEnv, modelPlaneEnv } from './env-scrub.mjs';
import { runGatePipeline } from './gate-pipeline.mjs';
import { runGates, checkFlail, MAX_OUTPUT_BYTES } from './gates.mjs';
import { getAdapter } from './adapters/index.mjs';
import { usageEvidence } from './adapters/usage.mjs';
import { transportCredential, transportEvidence } from './adapters/transport-credential.mjs';
import { ladderAdapters, seatForAttempt } from './quartermaster.mjs';
import { prosecute as prosecuteGate } from './prosecute.mjs';
import { makeReviewRunner } from './review-runner.mjs';
import { builderPrompt, fixPrompt } from './charters.mjs';
import { PROTECTED_PREFIXES, isUnderProtectedPrefix } from './protected-paths.mjs';
import { BASE_MANIFEST } from './protected-paths.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnAsync } from './spawn-async.mjs';
import { completeTicketOnIntegration, revertCompletionCommit, assertOnBranch } from './complete.mjs';
import { resolveKeyFromEnv } from '@adlc/tickets/lib/key-contract.mjs';

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
  const entryFor = (ticket) => seats?.get(ticket?.id) ?? null;

  // F8 escalation (issue #401): the seat belongs to the ATTEMPT, not to the run.
  // A ladder-start ticket in ladder mode climbs one rung per strike; everything
  // else hands back its routed seat unchanged for every attempt.
  const attemptFor = (ticket, attempt) => {
    const entry = entryFor(ticket);
    return entry ? seatForAttempt(entry, attempt) : null;
  };

  const adapterForSeat = (ticket, seat) => {
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
  // Every harness a ticket could run on, for the model-plane write grant (#395).
  // A ladder can escalate a later strike onto a different adapter, and the sandbox
  // is built per dispatch, so granting only the CURRENT rung would work until the
  // first escalation and then fail there -- the same reason provisioning covers
  // every rung rather than just the starting one (#401).
  const ladderAdaptersFor = (ticket, current) => {
    const entry = entryFor(ticket);
    const names = entry ? ladderAdapters(entry) : [];
    const mods = names.map((n) => getAdapter(n));
    return mods.includes(current) ? mods : [current, ...mods];
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

  // The MODEL-plane sandbox (spec 7.3; issue #395). Same backend and the same
  // run-wide mode decision as the repo-command plane -- deliberately, because that
  // is what keeps this from adding a second failure mode: a host with no backend
  // already refuses to dispatch at preflight, and an operator who passed
  // --i-am-in-a-disposable-container has already asserted the whole run is
  // contained. There is no model-plane-only opt-out to reason about.
  //
  // What DIFFERS from the repo-command profile is the network axis, and only that:
  // egress stays open (K2 -- the worker must reach its provider), while writes are
  // bounded to the worktree plus the harness's own declared state directories.
  // Per-RUN, not per-dispatch (finding 3): scoped to this deps object so a second
  // run in the same process still warns, and so tests stay independent of each other.
  const warnedMissingState = new Set();
  const modelSandboxFor = (worktree, adapters) => {
    const { writablePaths, missingStateFiles } = modelPlaneFilesystem({
      adapters,
      home: io.env.HOME,
      // NOT `io.env.TMPDIR` alone: that variable is usually UNSET on Linux, and an
      // unset temp dir means /tmp gets no write grant while `--ro-bind / /` has
      // already made it read-only — every harness that allocates a temp file would
      // then fail on exactly the platform bubblewrap serves. os.tmpdir() honours
      // TMPDIR when set and falls back to the platform default when it is not.
      tmpDir: io.env.TMPDIR || tmpdir(),
      extraWritable: config.modelPlaneWritable ?? [],
    });
    // Warn ONCE per run, not once per dispatch. A fleet runs many tickets and
    // retries strikes, so a per-dispatch warning about a state file this host
    // simply does not have would repeat dozens of times and train the operator to
    // scroll past the one message that tells them why their harness failed.
    const unwarned = missingStateFiles.filter((f) => !warnedMissingState.has(f));
    for (const f of unwarned) warnedMissingState.add(f);
    if (unwarned.length) {
      // Named, not swallowed: this is the one shape of the policy that can make a
      // previously-working run fail, and an opaque harness error is the worst way
      // for an operator to meet it.
      console.error(
        `fleet: model-plane sandbox is not granting ${unwarned.join(', ')} ` +
        '(declared harness state that does not exist on this host). If the worker fails to ' +
        'write it, re-run with --model-plane-writable <path>.'
      );
    }
    return new Sandbox({
      mode: sandboxSpec.mode,
      backend: sandboxSpec.backend,
      worktree,
      // No synthetic HOME: the worker reads its own subscription/session auth from
      // the real one (K2), and Seatbelt cannot remap a path anyway -- inventing a
      // synthetic home here would make the two backends enforce different policies
      // under one name.
      syntheticHome: null,
      writablePaths,
      network: NETWORK.ALLOW,
      readPolicy: READ_POLICY.HOST,
      exec: async (argv, opts) => io.spawnWorker(argv[0], argv.slice(1), opts),
    });
  };

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
    //
    // EVERY rung of the ladder is provisioned, not just the starting one (#401).
    // provision runs once, before the pipeline; escalation can move strike 2 onto
    // a different harness, and claude-code's provision writes the allowlist its
    // worker needs to run at all. Provisioning only the start would leave an
    // escalated strike unprovisioned, which is indistinguishable from a model
    // failure at the point it bites.
    provision: ({ ticket, worktree }) => {
      const entry = entryFor(ticket);
      if (!entry) return adapterForSeat(ticket, null).provision?.({ worktree, config, writeJson: io.writeJson });
      for (const name of ladderAdapters(entry)) {
        getAdapter(name).provision?.({ worktree, config, writeJson: io.writeJson });
      }
      return undefined;
    },

    dispatch: async ({ ticket, worktree, strike, deadEnds = [] }) => {
      const prompt = strike > 1 ? fixPrompt(ticket, config.gate, deadEnds) : builderPrompt(ticket, config.gate);
      const attempt = attemptFor(ticket, strike);
      const seat = attempt?.seat ?? null;
      const adapter = adapterForSeat(ticket, seat);
      // §4b transport is load-bearing HERE (#396): a seat's credential comes
      // from its transport class, not from the run-wide `config.modelAuthKey`.
      // A `subscription:` seat resolves to null — keep NO provider key — so the
      // harness has no metered path available and must use its own session.
      // That withholding is what stops an operator being billed metered rates
      // for capacity a subscription already covers. The un-engaged path (no
      // seat) keeps `config.modelAuthKey` exactly as it was.
      const env = modelPlaneEnv(io.env, {
        modelAuthKey: seat ? transportCredential(adapter, seat.transport) : config.modelAuthKey,
        extra: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: ticket.id },
      });
      // 7.3 / #395: the worker's own process is wrapped, so the repo-authored
      // `fleet.gate` commands its permission allowlist carries -- and the charter
      // tells it to run -- execute with the operator's WRITES bounded to this
      // worktree. Every ladder rung contributes its state declaration, because an
      // escalation can move a later strike onto a different harness.
      const modelSandbox = modelSandboxFor(worktree, ladderAdaptersFor(ticket, adapter));
      const res = await adapter.dispatch({
        worktree, prompt, timeoutMs: (config.timeoutMinutes ?? 30) * 60000, env,
        exec: (cmd, args, opts) => modelSandbox.run([cmd, ...args], opts),
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
      // The header names the CHANNEL as well as the strike (#401): with
      // escalation, two strikes of one ticket can be two different harnesses,
      // and a transcript that says only "strike 2" cannot tell an operator
      // which supply produced the output they are reading.
      const where = attempt?.channel
        ? ` channel=${attempt.channel}${attempt.escalatedFrom ? ` (escalated from ${attempt.escalatedFrom})` : ''}`
        : '';
      write(`=== ${ticket.id} strike ${strike}${where} ===\n${res.output ?? ''}\n`);
      // Commit the worker's changes (orchestrator commits; §6.3 pathspec excludes control dirs).
      if (res.exitCode === 0 && !res.timedOut && !/TICKET-BLOCKED/.test(res.output)) {
        try { worktrees.commitWorker(worktree, ticket.id, io.git(worktree)); }
        catch (e) {
          // This IS the failure the scheduler will act on, so it belongs in the
          // transcript the flail check analyzes — otherwise a commit failure
          // repeating across strikes can never reach the repeated-error signal.
          const output = `${res.output}\ncommit failed: ${e.message}`;
          write(`commit failed: ${e.message}\n`);
          // SPREAD `res`, do not rebuild it: the model call already happened and
          // its usage was already parsed. Returning a fresh three-field object
          // dropped usage/usageStatus/usageRaw, so a worker that succeeded but
          // produced nothing committable — a routine outcome — had its real
          // spend recorded as 'unreported' (adversarial-review).
          return { ...res, exitCode: 1, output, timedOut: false };
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
      completeTicketOnIntegration({ repo: integrationPath, ticketId: ticket.id, integrationBranch, git: integrationGit, key: resolveKeyFromEnv(io.env) }),

    // Withdraw ONLY the completion commit when the gate re-run over it fails; the
    // shipped merge underneath is never touched.
    revertCompletion: ({ toSha, shardPath, completionSha, integrationBranch, ledgerPath, raced }) =>
      revertCompletionCommit({ repo: integrationPath, toSha, shardPath, completionSha, integrationBranch, ledgerPath, raced, git: integrationGit }),

    cleanup: ({ worktree, state }) => {
      // Keep failed worktrees for inspection; remove merged ones.
      if (state === 'merged') worktrees.removeWorktree(repo, worktree, repoGit);
      worktrees.pruneWorktrees(repo, repoGit);
    },

    // Best-effort evidence: never block the run on a recorder error (AC5).
    /**
     * §8a: ONE usage carrier per dispatch, written immediately after the call
     * it accounts for and independent of any later verdict.
     *
     * Enriched from the quartermaster SEAT, because counters alone cannot be
     * priced or filtered: two channels can run the same model over different
     * transports (subscription vs metered API), and an operator auditing
     * overflow needs to tell them apart (adversarial-review HIGH). The seat is
     * the only place that knows, so the provenance is attached here rather
     * than guessed downstream.
     *
     * `registryDigest` is deliberately ABSENT: nothing in the quartermaster
     * produces one today, and §8a says record these siblings when supplied and
     * omit them cleanly otherwise. Emitting a placeholder would be a fabricated
     * provenance claim — the same failure the no-fabrication rule forbids for
     * counters.
     */
    recordDispatchUsage: ({ ticket, result, strike = 1 }) => {
      const data = usageEvidence(result);
      if (!data) return;
      const entry = seats?.get(ticket?.id);
      // Recording stays NON-BLOCKING — a recorder problem must never fail a
      // build — but it must not be SILENT. `io.adlc` is spawnSync-shaped, so an
      // ordinary CLI failure (missing binary, invalid chain, signing error)
      // comes back as a nonzero `status` and never throws: a bare try/catch
      // lets it pass as success. The carrier then simply does not exist, and a
      // missing entry is indistinguishable from a dispatch that never happened
      // — unknown silently becoming zero, one layer up from the counters
      // (adversarial-review).
      const warn = (why) => console.error(
        `warning: ${ticket.id} dispatch usage was NOT recorded (${why}). This call's spend is `
        + 'MISSING from the ledger, not zero — phase totals will under-report until it is re-recorded.'
      );

      // The carrier must name the seat that ACTUALLY ran, not the one the run
      // started on (#401). Recording the starting channel for an escalated
      // strike is the same "the label proves nothing about what ran" failure
      // §4c closed for `model` — and it would price the escalation at the cheap
      // seat's transport. `strike` defaults to 1 so a caller with no attempt
      // number gets the starting seat, which is what it was before escalation
      // existed; run.mjs always passes the real one.
      //
      // An UNUSABLE strike resolves to no seat rather than propagating: this
      // whole call is wrapped in a best-effort try/catch one layer up, so a
      // throw here would discard the entire carrier and lose a real call's
      // spend without a word — the exact silent-zero the warning above exists
      // to prevent. Dropping only the provenance keeps the counters, and says
      // so out loud.
      let attempt = null;
      try {
        attempt = entry ? seatForAttempt(entry, strike) : null;
      } catch (e) {
        console.error(
          `warning: ${ticket.id} dispatch usage recorded WITHOUT channel provenance (${e.message}). `
          + 'The counters are real; the channel/transport that spent them is unknown for this entry.'
        );
      }
      const seat = attempt?.seat;
      if (data.usage && seat) {
        data.usage = {
          ...data.usage,
          ...(seat.provider ? { provider: seat.provider } : {}),
          ...(seat.model ? { model: seat.model } : {}),
          ...(entry?.assignment?.tier ? { tier: entry.assignment.tier } : {}),
        };
      }
      if (attempt?.channel) data.channel = attempt.channel;
      // Present ONLY on a dispatch that actually climbed, so the absence of the
      // key is itself evidence that this strike ran where routing put it.
      if (attempt?.escalatedFrom) data.escalatedFrom = attempt.escalatedFrom;
      // §4b transport, plus the status that keeps it honest (#396): `selected`
      // says this credential context was CHOSEN for the call, never that the
      // harness confirmed it served it — the same discipline T152 applied to
      // token counters with `usageStatus`.
      Object.assign(data, transportEvidence(seat?.transport));
      // Binds the charge to the registry BYTES in force at dispatch time. The
      // operator registry is mutable, so channel/transport labels alone cannot
      // prove which registry version chose them.
      if (entry?.registryDigest) data.registryDigest = entry.registryDigest;

      let res;
      try { res = io.adlc(['gate-manifest', 'record', 'p4', '--ticket', ticket.id, '--data', JSON.stringify(data)], {}); }
      catch (e) { warn(e.message); return; }
      if (res?.error) warn(res.error.message);
      else if (res?.signal) warn(`recorder killed by ${res.signal}`);
      else if (typeof res?.status !== 'number') warn('recorder produced no exit status');
      else if (res.status !== 0) warn(`recorder exited ${res.status}: ${(res.stderr ?? '').trim()}`.trim());
    },

    recordGate: ({ ticket, phase, ok, data }) => {
      // §8a: `data` carries the dispatch's parsed usage (or just its
      // usageStatus when the harness reported nothing). Passed only when
      // present, so a recorder with nothing to say still emits the same argv it
      // always did — this stays a pure addition to the evidence, not a change
      // to what an existing entry looks like.
      const argv = ['gate-manifest', 'record', phase, '--ticket', ticket.id, ok ? '--pass' : '--fail'];
      if (data !== undefined) argv.push('--data', JSON.stringify(data));
      try { io.adlc(argv, {}); }
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
