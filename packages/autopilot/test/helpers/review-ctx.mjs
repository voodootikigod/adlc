// The `ctx` harness for the review / push / ci / maintain / digest / status
// suites: fake children by executable path (fake-children.mjs) with an
// optional REAL git, the real record/status stores in a temp REPO_ROOT, and a
// minimal git runner shaped like lib/git-runner.mjs (local / localOut / net /
// observe). Nothing here touches the network.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as cpSpawn } from 'node:child_process';
import { createSpawner, DEADLINES } from '../../lib/spawn.mjs';
import { autopilotPaths } from '../../lib/paths.mjs';
import { createRedactor } from '../../lib/redact.mjs';
import { createRecordStore } from '../../lib/records.mjs';
import { createStatusStore } from '../../lib/status.mjs';
import { createGh } from '../../lib/github.mjs';
import { AUTOPILOT_DEFAULTS } from '../../lib/config.mjs';
import { gitBaseEnv, networkGitEnv, netGitArgv, writeNetGit } from '../../lib/git-env.mjs';
import { fakeSpawnImpl } from './fake-children.mjs';

export const FAKE = Object.freeze({
  adlc: '/fake/bin/adlc', gh: '/fake/bin/gh', git: '/fake/bin/git', 'adversarial-review': '/fake/bin/adversarial-review',
  claude: '/fake/bin/claude', codex: '/fake/bin/codex', npm: '/fake/bin/npm', node: process.execPath, bwrap: '/fake/bin/bwrap',
  ssh: '/fake/bin/ssh', 'ssh-add': '/fake/bin/ssh-add', 'ssh-keygen': '/fake/bin/ssh-keygen',
});
export const REAL_GIT = '/usr/bin/git';
export const KEY = 'autopilot-test-manifest-key-0123456789abcdef';
export const OID = Object.freeze({ a: 'a'.repeat(40), b: 'b'.repeat(40), c: 'c'.repeat(40), d: 'd'.repeat(40), base: '1'.repeat(40) });
export const TOKEN = 'f'.repeat(64);
export const TICKET = 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH';

export const scratch = (prefix) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `${prefix}-`));
export const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };

/** Fake children for every handled executable; the listed `real` executables run for real. */
export function hybridSpawnImpl(handlers, { real = [] } = {}) {
  const fake = fakeSpawnImpl(handlers);
  return {
    spawnImpl(exe, args, opts) {
      if (real.includes(exe) && !handlers[exe]) return cpSpawn(exe, args, opts);
      return fake.spawnImpl(exe, args, opts);
    },
    kill(pid, signal) { try { fake.kill(pid, signal); } catch { process.kill(pid, signal); } },
  };
}

/**
 * @param opts.repoRoot   temp REPO_ROOT (created by the caller; a real repo when realGit)
 * @param opts.handlers   fake-children handler table keyed by pinned path
 * @param opts.realGit    use /usr/bin/git for every git spawn
 * @param opts.netGit     (realGit) write NET_GIT under the run dir with the given remote URLs
 */
export function buildCtx({ repoRoot, handlers = {}, realGit = false, netGit = false, realExes = [], pinned = {}, config = {}, remote = {}, now = null, quota = null, lockToken = null, observations = {} } = {}) {
  const paths = autopilotPaths(repoRoot);
  mkdirSync(paths.runsDir, { recursive: true });
  const home = join(repoRoot, '.home'); mkdirSync(home, { recursive: true });
  const pin = { ...FAKE, ...(realGit ? { git: REAL_GIT } : {}), ...pinned };
  const recorder = [];
  const { spawnImpl, kill } = hybridSpawnImpl(handlers, { real: [...(realGit ? [REAL_GIT] : []), ...realExes] });
  const spawn = createSpawner({ recorder, spawnImpl, kill });
  const base = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
  const redactor = createRedactor({ secretValues: [KEY] });
  let clock = 1_756_400_000_000; // 2026-08-28T…
  const nowFn = now ?? (() => clock);
  const records = createRecordStore({ paths, redactor, now: () => new Date(nowFn()).toISOString() });
  const status = createStatusStore({ paths, lockToken, redactor, now: nowFn });
  const rem = { remoteFetchUrl: 'git@github.com:o/r.git', remotePushUrl: 'git@github.com:o/r.git', host: 'github.com', repo: 'o/r', ...remote };
  const gh = createGh({ spawn, gh: pin.gh, host: rem.host, repo: rem.repo, env: base, cwd: repoRoot, sleep: async () => {} });
  const gitEnv = gitBaseEnv({ path: base.PATH, home: base.HOME });
  const local = (cwd, args, { deadlineMs = DEADLINES.git, stdinBytes } = {}) => spawn({ argv: [pin.git, ...args], cwd, env: gitEnv, deadlineMs, stdinBytes, label: `git ${args[0]}` });
  const localOut = async (cwd, args) => {
    const r = await local(cwd, args);
    if (r.status !== 0) { const e = new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`); e.code = 'git-failed'; throw e; }
    return r.stdout.trim();
  };
  const netEnv = networkGitEnv({ base: gitEnv, remoteFetchUrl: rem.remoteFetchUrl, remotePushUrl: rem.remotePushUrl, sshWrapperPath: '/bin/true' });
  const net = (args) => spawn({ argv: netGitArgv(pin.git, paths.netGit, ...args), cwd: repoRoot, env: netEnv, deadlineMs: DEADLINES.gitNetwork, label: `git net ${args[0]}` });
  if (realGit && netGit) writeNetGit({ netGit: paths.netGit, repoRoot, remoteFetchUrl: rem.remoteFetchUrl, remotePushUrl: rem.remotePushUrl, sshWrapperPath: '/bin/true' });
  const ctx = {
    repoRoot, paths, spawn, recorder, pinned: pin, env: { path: base.PATH, home: base.HOME, base }, key: KEY, redactor,
    config: { autopilot: { ...AUTOPILOT_DEFAULTS, repo: rem.repo, ...config }, fleet: {}, ticketSync: {} },
    remote: rem, netGit: paths.netGit, gh, records, status,
    quota: quota ?? { sample: async ({ ordinal = 1 } = {}) => ({ ok: true, reason: null, ordinal, windows: { fiveHour: 10, sevenDay: 10, scoped: null } }), reconcile: async () => ({}) },
    lock: { token: lockToken, heartbeat() {}, release() {} },
    observations,
    now: nowFn, advance: (ms) => { clock += ms; }, log: () => {}, dryRun: false, baseOid: OID.base, iterationId: 'it-1',
  };
  ctx.git = { local, localOut, net, observe: async (key) => (typeof ctx.observations === 'function' ? ctx.observations(key) : ctx.observations[key] ?? null) };
  return ctx;
}

/** Recorded spawns of one executable → their tool argvs (argv minus the executable). */
export const argvsOf = (ctx, exe) => ctx.recorder.filter((r) => r.argv[0] === exe).map((r) => r.argv.slice(1));
/** gh mutating calls (anything that is not a read). */
export const ghMutations = (ctx) => argvsOf(ctx, ctx.pinned.gh).filter((a) => /^(create|edit|comment|close|merge|delete)$/.test(a[1] ?? '') || a.includes('--add-label') || a.includes('--remove-label'));
/** git push argvs recorded (local or NET_GIT). */
export const pushes = (ctx) => ctx.recorder.filter((r) => r.argv[0] === ctx.pinned.git && r.argv.includes('push')).map((r) => r.argv.slice(1));

/** A JSON-printing gh handler over a routing table `[[predicate(args), responder(args)]]`. */
export function ghRouter(routes) {
  return (args, meta) => {
    for (const [match, respond] of routes) if (match(args)) { const out = respond(args, meta); return typeof out === 'string' ? { stdout: out } : out; }
    return { stdout: '{}' };
  };
}

/** A minimal pr-open record. */
export function prOpenRecord({ issue = 7, prNumber = 41, attestedHead = OID.b, lastPushedOid = OID.b, baseOid = OID.base, state = 'pr-open', extra = {} } = {}) {
  return {
    issue, token: TOKEN, state, baseOid, branch: `adlc/autopilot/issue-${issue}`, finalBranch: `adlc/autopilot/issue-${issue}`,
    runId: `run-${issue}`, ticketId: TICKET, prNumber, prState: 'OPEN', roundsUsed: 0, wallClockUsedMs: 0, ciRoundsUsed: 0,
    lastPushedOid, lastPushedAt: '2026-08-28T00:00:00.000Z', localHead: attestedHead, attestedHead, reviewedHead: attestedHead,
    attestRevision: 'rev-1', manifestLinesWritten: [], effects: {}, digestPosted: false, createdAt: '2026-08-28T00:00:00.000Z', ...extra,
  };
}
