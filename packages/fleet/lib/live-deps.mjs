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
import { runGates, checkFlail } from './gates.mjs';
import { getAdapter } from './adapters/index.mjs';
import { prosecute as prosecuteGate } from './prosecute.mjs';
import { makeReviewRunner } from './review-runner.mjs';
import { builderPrompt, fixPrompt } from './charters.mjs';
import { PROTECTED_PREFIXES, isUnderProtectedPrefix } from './protected-paths.mjs';
import { BASE_MANIFEST } from './protected-paths.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnAsync } from './spawn-async.mjs';

// Ignore fleet working state WITHOUT committing to the base checkout
// (adversarial-review L2). `.git/info/exclude` is a local, per-repo, UNcommitted
// ignore file — the fleet never writes base history.
function ensureLocalExclude(repoDir) {
  const p = join(repoDir, '.git', 'info', 'exclude');
  const want = ['.worktrees/', '.adlc/fleet-status.json', '.adlc/fleet-logs/', '.adlc/fleet.lock/'];
  let cur = '';
  try { cur = existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return; }
  const lines = cur.split('\n');
  const missing = want.filter((l) => !lines.includes(l));
  if (missing.length) {
    try { appendFileSync(p, (cur.endsWith('\n') || cur === '' ? '' : '\n') + missing.join('\n') + '\n'); } catch { /* best effort */ }
  }
}

export function defaultIo() {
  return {
    git: (dir) => defaultGit(dir),
    // Sync adlc for the quick, off-hot-path calls (flail between strikes;
    // best-effort gate-manifest recording). The per-ticket rails-guard on the
    // gate path uses adlcAsync so it does not block the event loop (#164).
    adlc: (args, opts = {}) => spawnSync('adlc', args, { encoding: 'utf8', ...opts }),
    adlcAsync: (args, opts = {}) => spawnAsync('adlc', args, { encoding: 'utf8', ...opts }),
    // Async (non-blocking) worker/gate/review execution so the concurrent
    // scheduler is not serialized by a blocking spawn (#164).
    spawnWorker: (cmd, args, opts) => spawnAsync(cmd, args, { encoding: 'utf8', ...opts }),
    readFile: (p) => readFileSync(p, 'utf8'),
    exists: (p) => existsSync(p),
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    writeJson: (p, obj) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); },
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
export function buildLiveDeps({ repo, config, statusDir, sandboxSpec, reviewRunner, io = defaultIo() }) {
  const repoGit = io.git(repo);
  // Resolve the configured worker harness (T44). Fails closed on an unknown name.
  const adapter = getAdapter(config.adapter ?? 'claude-code');
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
      worktrees.createIntegrationBranch(repo, integrationBranch, baseSha, repoGit);
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
    provision: ({ worktree }) => adapter.provision?.({ worktree, config, writeJson: io.writeJson }),

    dispatch: async ({ ticket, worktree, strike, deadEnds = [] }) => {
      const prompt = strike > 1 ? fixPrompt(ticket, config.gate, deadEnds) : builderPrompt(ticket, config.gate);
      const env = modelPlaneEnv(io.env, {
        modelAuthKey: config.modelAuthKey,
        extra: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: ticket.id },
      });
      const res = await adapter.dispatch({
        worktree, prompt, timeoutMs: (config.timeoutMinutes ?? 30) * 60000, env,
        exec: (cmd, args, opts) => io.spawnWorker(cmd, args, opts),
        // Operator-local binary override (A2) + non-executable data from config.
        command: config.adapterCommand ?? undefined,
        args: config.adapterArgs ?? undefined,
        model: config.model ?? undefined,
        useStdin: config.adapterStdin === true, // pi RPC/stdin prompt transport (A3)
      });
      // Commit the worker's changes (orchestrator commits; §6.3 pathspec excludes control dirs).
      if (res.exitCode === 0 && !res.timedOut && !/TICKET-BLOCKED/.test(res.output)) {
        try { worktrees.commitWorker(worktree, ticket.id, io.git(worktree)); }
        catch (e) { return { exitCode: 1, output: `${res.output}\ncommit failed: ${e.message}`, timedOut: false }; }
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
      join(statusDir ?? join(repo, '.adlc'), 'fleet-logs', `${ticket.id}.log`),
      ticket.scope,
      { adlcBin, exec: (_bin, args) => { const r = io.adlc(args, {}); if (r.status !== 0 && !r.stdout) throw new Error('flail-detector failed'); return r.stdout; } },
    ),

    mergeToIntegration: ({ branch, integrationBranch }) => worktrees.mergeToIntegration(repo, branch, integrationBranch, repoGit),

    postMergeGate: ({ integrationBranch }) => {
      // Run the configured gate on the integration branch in the repo, sandboxed.
      repoGit('checkout', integrationBranch);
      return runGates(sandboxFor(repo), config.gate, repoCmdEnv(repo));
    },

    revertMerge: ({ integrationBranch, mergeSha, preMergeSha }) =>
      worktrees.revertMerge(repo, integrationBranch, { mergeSha, preMergeSha }, repoGit),

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

    openPR: ({ integrationBranch, base }) => {
      if (!io.hasGh()) return { opened: false, reason: 'gh CLI not available' };
      try {
        repoGit('push', '-u', 'origin', integrationBranch);
        io.spawnWorker('gh', ['pr', 'create', '--base', base, '--head', integrationBranch, '--fill'], { cwd: repo });
        return { opened: true };
      } catch (e) { return { opened: false, reason: e.message }; }
    },
  };
}

export { PROTECTED_PREFIXES };
