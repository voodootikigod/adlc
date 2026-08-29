// fleet-ext items 11–14 as WIRED through buildLiveDeps: the bounded model-plane
// profile with its synthetic HOME, the egress allowlist bridge, and the git
// mirror cut / fetch-back / gate-worktree flow. The isolated modules have their
// own suites; this file proves live-deps actually composes them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLiveDeps } from '../lib/live-deps.mjs';
import { advanceTicket } from '../lib/scheduler.mjs';
import { BRIDGE_PATH, bridgeArgv, mirrorCreateWorktree, mirrorFetchBack } from '../lib/extensions.mjs';
import { SYSTEM_ROOTS } from '../lib/bounded-model-plane.mjs';
import { startEgressProxy, egressEnv } from '../lib/egress-proxy.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { assertBareMirror, assertMirrorConfigPristine } from '../lib/git-mirror.mjs';
import { detectBackend } from '../lib/sandbox.mjs';
import { probeBwrap } from './helpers/bwrap-probe.mjs';
import { BoundedModelSandbox } from '../lib/bounded-model-plane.mjs';
import { findInner, unwrapAll } from './helpers/worker-calls.mjs';

const ticket = { id: 'T1', title: 'T1', scope: ['packages/x/**'], body: 'do', edges: [] };
const sandboxSpec = { mode: 'sandbox', backend: { name: 'bubblewrap' } };
const HOME = '/home/op';

/** A fake fs for prepareSyntheticHome: a valid 0600 credential, a settings.json with hooks, a plugins dir. */
function fakeHomeFs(uid) {
  const files = {
    [`${HOME}/.claude/.credentials.json`]: '{"claudeAiOauth":{"accessToken":"tok"}}',
    [`${HOME}/.claude/settings.json`]: JSON.stringify({ model: 'opus', hooks: { PreToolUse: [] }, mcpServers: {} }),
    [`${HOME}/.claude.json`]: JSON.stringify({ oauthAccount: { id: 1 }, projects: { '/x': {} } }),
  };
  const written = {};
  return {
    written,
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0 },
    openSync: (p) => { if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return p; },
    fstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, uid, mode: 0o100600, size: 10 }),
    readFileSync: (p) => { if (typeof p === 'string' && p in files) return Buffer.from(files[p]); if (p in written) return written[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    closeSync: () => {},
    statSync: (p) => { if (p === `${HOME}/.claude/plugins`) return { isDirectory: () => true }; if (p in files) return { isFile: () => true, isDirectory: () => false, uid, mode: 0o100600 }; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    lstatSync: (p) => { if (p === `${HOME}/.claude/plugins`) return { isDirectory: () => true, isSymbolicLink: () => false }; if (p in files) return { isFile: () => true, isSymbolicLink: () => false, uid, mode: 0o100600 }; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    existsSync: (p) => p in files || p === `${HOME}/.claude/plugins`,
    mkdirSync: () => {},
    writeFileSync: (p, bytes) => { written[p] = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8'); },
    chmodSync: () => {},
  };
}

function fakeIo(rec, { uid = 1000, isFile = () => true, homeFs } = {}) {
  const proxies = [];
  return {
    proxies,
    git: () => (...args) => (args[0] === 'rev-parse' ? 'SHA' : ''),
    adlc: () => ({ status: 0, stdout: '' }), adlcAsync: async () => ({ status: 0, stdout: '' }),
    spawnWorker: async (cmd, args, opts) => { rec.spawn.push({ cmd, args, opts }); return { status: 0, stdout: 'TICKET-DONE', stderr: '' }; },
    readFile: () => '', exists: () => false, mkdirp: () => {}, writeJson: () => {}, appendLog: () => {}, ensureGitignore: () => {}, copyTree: () => {},
    env: { PATH: '/usr/bin', HOME }, hasGh: () => false, uid, isFile, homeFs: homeFs ?? fakeHomeFs(uid),
    // the adapter executable as the HOST resolves it (a real file outside the plane's tmpfs HOME)
    resolveExecutable: (command) => (command === 'claude' ? `${HOME}/.local/bin/claude` : null),
    startEgressProxy: async ({ socketPath, allowlist }) => { const p = { socketPath, allowlist: [...allowlist], refused: [], closed: false, close: async () => { p.closed = true; } }; proxies.push(p); return p; },
  };
}
const newRec = () => ({ spawn: [] });

test('bounded reads: the worker runs under a bwrap profile with --tmpfs /tmp, a tmpfs HOME, the three home leaves, single-file tool binds and NO --ro-bind / /', async () => {
  const rec = newRec();
  const io = fakeIo(rec);
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-'));
  try {
    const deps = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr', '/lib', `${HOME}/.local/bin/claude`] } });
    const r = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r.exitCode, 0);
    const call = findInner(rec.spawn, `${HOME}/.local/bin/claude`);
    assert.ok(call, 'the worker was spawned by the resolved ABSOLUTE path of the adapter executable (codex r5)');
    const w = call.wrapper.args;
    assert.equal(call.wrapper.cmd, 'bwrap');
    const pairs = w.map((a, i) => `${a} ${w[i + 1]}`);
    assert.ok(!pairs.includes('--ro-bind /'), 'never --ro-bind / /');
    assert.ok(pairs.includes('--tmpfs /tmp'), 'private tmpfs at /tmp');
    assert.ok(pairs.includes(`--tmpfs ${HOME}`), 'tmpfs at HOME');
    assert.ok(pairs.includes('--ro-bind /usr') && pairs.includes('--ro-bind /lib'));
    assert.ok(pairs.includes(`--ro-bind ${HOME}/.local/bin/claude`), 'the pinned tool is a single-file bind');
    assert.ok(!pairs.includes(`--ro-bind ${HOME}/.local/bin`), 'its parent directory is not exposed');
    const setenv = w.filter((a, i) => w[i - 1] === '--setenv');
    assert.ok(setenv.includes('HOME') && setenv.includes('TMPDIR'));
    for (const leaf of ['.claude/.credentials.json', '.claude/settings.json', '.claude/plugins']) assert.ok(w.includes(`${HOME}/${leaf}`), `home bind ${leaf}`);
    assert.ok(!w.includes('--unshare-net'), 'open egress keeps the network');
    const d = deps.describeSandbox();
    assert.equal(d.readPolicy, 'bounded'); assert.equal(d.privateTmp, true); assert.equal(d.egress, 'open');
    assert.deepEqual(d.homeBinds, [`${HOME}/.claude/.credentials.json`, `${HOME}/.claude/settings.json`, `${HOME}/.claude/plugins`]);
    assert.ok(d.writableRoots.includes('/wt/T1'));
    // The staged settings inside the synthetic home carry no hooks/mcpServers.
    const staged = Object.entries(io.homeFs.written).find(([p]) => p.endsWith('settings.json'))[1];
    assert.ok(!/hooks|mcpServers/.test(staged));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('allowlist egress: the worker is wrapped in the bridge, gets HTTPS_PROXY to it, runs under --unshare-net, and the proxy is closed after the dispatch', async () => {
  const rec = newRec();
  const io = fakeIo(rec);
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-'));
  try {
    const deps = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'], modelPlaneEgress: 'allowlist' } });
    await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    const [raw] = rec.spawn;
    const inner = raw.args.slice(raw.args.indexOf('--') + 1);
    assert.equal(inner[0], process.execPath, 'the pinned node runs the bridge');
    assert.equal(inner[1], BRIDGE_PATH);
    assert.equal(inner[2], '--socket'); assert.ok(inner[3].endsWith('proxy.sock')); assert.equal(inner[4], '--port'); assert.equal(inner[5], '8118'); assert.equal(inner[6], '--');
    assert.equal(inner[7], `${HOME}/.local/bin/claude`, 'then the worker, by its bound absolute path (codex r6)');
    assert.ok(raw.args.includes('--unshare-net'));
    assert.equal(raw.opts.env.HTTPS_PROXY, 'http://127.0.0.1:8118'); assert.equal(raw.opts.env.HTTP_PROXY, 'http://127.0.0.1:8118'); assert.equal(raw.opts.env.NO_PROXY, '');
    assert.equal(io.proxies.length, 1);
    assert.deepEqual(io.proxies[0].allowlist, ['api.anthropic.com:443', 'console.anthropic.com:443', 'platform.claude.com:443'], "the adapter's declared hosts");
    assert.equal(io.proxies[0].closed, true, 'closed after the dispatch');
    const d = deps.describeSandbox();
    assert.equal(d.egress, 'allowlist'); assert.deepEqual(d.egressAllowlist, io.proxies[0].allowlist);
    const bridgeBind = raw.args.some((a, i) => a === '--ro-bind' && raw.args[i + 1] === realpathSync(BRIDGE_PATH));
    assert.ok(bridgeBind, 'the bridge file is bound read-only into the sandbox');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the credential copy is staged in an EPHEMERAL directory outside the repository and removed after the dispatch — on the success path and on a policy failure', async () => {
  const rec = newRec();
  const io = fakeIo(rec);
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-'));
  const tmpRoot = mkdtempSync(join(tmpdir(), 'fleet-ext-tmproot-'));
  try {
    io.env = { ...io.env, TMPDIR: tmpRoot };
    const deps = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'], modelPlaneEgress: 'allowlist' } });
    await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    const w = rec.spawn[0].args;
    const credSource = w[w.indexOf(`${HOME}/.claude/.credentials.json`) - 1];
    assert.ok(credSource.startsWith(tmpRoot + '/fleet-home-'), `the staging source ${credSource} is under the ephemeral root, not the repo`);
    assert.ok(!credSource.startsWith(dir), 'never under .adlc');
    assert.equal(readdirSync(tmpRoot).length, 0, 'the staging directory (credential copy + socket) is gone after the dispatch');
    assert.equal(io.proxies[0].closed, true);
    // A policy failure raised AFTER staging also cleans up.
    const deps2 = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/wt'], modelPlaneEgress: 'allowlist' } });
    const r = await deps2.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r.policyMismatch, true);
    assert.equal(readdirSync(tmpRoot).length, 0, 'nothing staged survives a policy failure');
    assert.equal(io.proxies[1].closed, true, 'a proxy started before the failure is closed');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('bounded mode is claude-code only: another adapter is sandbox-policy-mismatch before anything is staged', async () => {
  const rec = newRec();
  const io = fakeIo(rec);
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-'));
  try {
    const deps = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'], adapter: 'codex' } });
    const r = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r.exitCode, 1); assert.equal(r.policyMismatch, true); assert.match(r.output, /claude-code only/);
    assert.equal(rec.spawn.length, 0);
    assert.equal(Object.keys(io.homeFs.written).length, 0, 'no credential copy was staged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a read-only entry that is an ancestor of the worktree is sandbox-policy-mismatch: no worker spawn, exit 1', async () => {
  const rec = newRec();
  const io = fakeIo(rec);
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-'));
  try {
    const deps = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/wt'] } });
    const r = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r.exitCode, 1); assert.equal(r.policyMismatch, true); assert.match(r.output, /sandbox-policy-mismatch/);
    assert.equal(rec.spawn.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('host read policy (default) is byte-identical: no tmpfs, no home leaves, describeSandbox reports host', async () => {
  const rec = newRec();
  const deps = buildLiveDeps({ repo: '/repo', statusDir: undefined, sandboxSpec, io: fakeIo(rec), config: { gate: { test: 't' }, timeoutMinutes: 1 } });
  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
  const w = findInner(rec.spawn, 'claude').wrapper.args;
  assert.ok(w.some((a, i) => a === '--ro-bind' && w[i + 1] === '/' && w[i + 2] === '/'), 'the legacy host profile');
  assert.ok(!w.includes('--tmpfs'));
  assert.equal(deps.describeSandbox().readPolicy, 'host');
});

// ── the mirror flow against REAL git ──────────────────────────────────────────
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const sh = (cwd, ...args) => { const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const gitAt = (dir) => (...args) => sh(dir, ...args);

function mirrorFixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'fleet-mirror-')));
  const repo = join(root, 'repo'); mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.txt'), 'a\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'base');
  sh(repo, 'branch', 'adlc/autopilot/issue-7'); sh(repo, 'branch', 'other');
  const mirror = join(root, 'mirror.git');
  sh(root, 'clone', '-q', '--bare', '--no-local', '--single-branch', '--branch', 'adlc/autopilot/issue-7', repo, mirror);
  sh(mirror, 'remote', 'remove', 'origin');
  return { root, repo, mirror };
}

test('mirror mode: the worktree is cut from the mirror, the worker commit is fetched back by CAS onto fleet/<id> in the caller repo, and the gate worktree is at it', async () => {
  const { root, repo, mirror } = mirrorFixture();
  try {
    const rec = newRec();
    const io = fakeIo(rec);
    io.git = gitAt;
    io.spawnWorker = async (cmd, args, opts) => {
      rec.spawn.push({ cmd, args, opts });
      if (cmd === 'bwrap' || cmd === 'claude') { writeFileSync(join(opts.cwd ?? root, 'worker.txt'), 'built\n'); return { status: 0, stdout: 'TICKET-DONE', stderr: '' }; }
      return { status: 0, stdout: '', stderr: '' };
    };
    const deps = buildLiveDeps({ repo, statusDir: join(repo, '.adlc'), sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'], modelPlaneGit: 'mirror', modelPlaneGitMirror: mirror } });
    const wt = await deps.createWorktree({ ticket, integrationBranch: 'adlc/autopilot/issue-7' });
    assert.equal(wt.path, join(repo, '.worktrees', 'fleet-t1'));
    assert.equal(wt.gatePath, join(repo, '.worktrees', 'fleet-t1-gate'));
    assert.match(sh(wt.path, 'rev-parse', '--git-common-dir'), new RegExp(mirror.replace(/[.]/g, '\\.')), "the worker worktree's git database IS the mirror");
    assert.equal(sh(repo, 'rev-parse', 'fleet/t1'), wt.startSha, 'fleet/t1 exists in the caller repo at the cut tip');
    // The worker cannot enumerate `other` from inside its worktree.
    assert.ok(!sh(wt.path, 'for-each-ref', '--format=%(refname)').includes('refs/heads/other'));
    const r = await deps.dispatch({ ticket, worktree: wt.path, startSha: wt.startSha, strike: 1, deadEnds: [], gateWorktree: wt.gatePath, branch: wt.branch });
    assert.equal(r.exitCode, 0, r.output);
    assert.equal(r.mirrorFetchFailed, undefined);
    const tip = sh(repo, 'rev-parse', 'fleet/t1');
    assert.notEqual(tip, wt.startSha, 'the worker commit landed on the caller repo branch');
    assert.equal(sh(repo, 'show', `${tip}:worker.txt`), 'built');
    assert.equal(sh(wt.gatePath, 'rev-parse', 'HEAD'), tip, 'the gate worktree is at the fetched-back commit');
    assert.equal(sh(wt.gatePath, 'symbolic-ref', '--short', 'HEAD'), 'fleet/t1');
    assert.ok(!existsSync(join(repo, '.git', 'refs', 'fleet', 'fetched')) || sh(repo, 'for-each-ref', 'refs/fleet/fetched') === '', 'the temp ref is gone');
    const d = deps.describeSandbox();
    assert.equal(d.gitSource, 'mirror'); assert.equal(d.mirror, mirror);
    assert.ok(d.writableRoots.includes(mirror), 'the mirror is a writable root');
    // Strike 2 fetch-back uses the NEW tip as its CAS baseline.
    io.spawnWorker = async (cmd, args, opts) => { rec.spawn.push({ cmd, args, opts }); if (cmd === 'bwrap' || cmd === 'claude') { writeFileSync(join(opts.cwd, 'worker2.txt'), 'x\n'); return { status: 0, stdout: 'TICKET-DONE', stderr: '' }; } return { status: 0, stdout: '' }; };
    const r2 = await deps.dispatch({ ticket, worktree: wt.path, startSha: wt.startSha, strike: 2, deadEnds: ['x'], gateWorktree: wt.gatePath, branch: wt.branch });
    assert.equal(r2.exitCode, 0, r2.output);
    assert.equal(sh(repo, 'show', `${sh(repo, 'rev-parse', 'fleet/t1')}:worker2.txt`), 'x');
    deps.cleanup({ ticket, worktree: wt.path, state: 'merged' });
    assert.ok(!existsSync(wt.path) && !existsSync(wt.gatePath), 'cleanup removes both worktrees');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mirror mode: a mirror tip that does not descend from the cut tip → mirrorFetchFailed, the caller branch untouched, scheduler reason mirror-fetch-failed', async () => {
  const { root, repo, mirror } = mirrorFixture();
  try {
    const rec = newRec();
    const io = fakeIo(rec);
    io.git = gitAt;
    io.spawnWorker = async (cmd, args, opts) => {
      rec.spawn.push({ cmd, args, opts });
      if (cmd === 'bwrap' || cmd === 'claude') {
        // A hostile worker rewrites its branch to an orphan commit inside the mirror.
        sh(opts.cwd, 'checkout', '-q', '--orphan', 'tmp'); writeFileSync(join(opts.cwd, 'evil.txt'), 'e\n'); sh(opts.cwd, 'add', '-A'); sh(opts.cwd, 'commit', '-q', '-m', 'orphan');
        sh(opts.cwd, 'branch', '-f', 'fleet/t1'); sh(opts.cwd, 'checkout', '-q', 'fleet/t1'); sh(opts.cwd, 'branch', '-D', 'tmp');
        // ...and leaves ordinary uncommitted work, so the orchestrator's commit succeeds on the orphan.
        writeFileSync(join(opts.cwd, 'more.txt'), 'm\n');
        return { status: 0, stdout: 'TICKET-DONE', stderr: '' };
      }
      return { status: 0, stdout: '' };
    };
    const deps = buildLiveDeps({ repo, statusDir: join(repo, '.adlc'), sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'], modelPlaneGit: 'mirror', modelPlaneGitMirror: mirror } });
    const wt = await deps.createWorktree({ ticket, integrationBranch: 'adlc/autopilot/issue-7' });
    const before = sh(repo, 'rev-parse', 'fleet/t1');
    const r = await deps.dispatch({ ticket, worktree: wt.path, startSha: wt.startSha, strike: 1, deadEnds: [], gateWorktree: wt.gatePath, branch: wt.branch });
    assert.equal(r.mirrorFetchFailed, true);
    assert.equal(r.exitCode, 1);
    assert.equal(sh(repo, 'rev-parse', 'fleet/t1'), before, 'the caller branch is untouched');
    assert.equal(sh(repo, 'for-each-ref', 'refs/fleet/fetched'), '', 'the temp ref is deleted');
    const outcome = await advanceTicket(ticket, { dispatch: () => r, gate: () => ({ ok: true }), prosecute: () => ({ verdict: 'pass' }), merge: () => ({ ok: true }), flail: () => ({ flail: false }) }, { maxStrikes: 2 });
    assert.equal(outcome.reasonCode, 'mirror-fetch-failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mirrorCreateWorktree on a second run resets fleet/<id> to the new cut tip (a stale branch from the previous run never breaks the CAS)', () => {
  const { root, repo, mirror } = mirrorFixture();
  try {
    const a = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    writeFileSync(join(a.path, 'w.txt'), '1\n'); sh(a.path, 'add', '-A'); sh(a.path, 'commit', '-q', '-m', 'w1');
    const fb = mirrorFetchBack({ repo, mirror, workerBranch: a.branch, cutTip: a.cutTip, gatePath: a.gatePath, gitAt });
    assert.equal(fb.ok, true);
    // Advance the issue branch (as the autopilot's ff would) and re-cut.
    sh(repo, 'update-ref', 'refs/heads/adlc/autopilot/issue-7', fb.sha);
    sh(mirror, 'fetch', '-q', repo, `+refs/heads/adlc/autopilot/issue-7:refs/heads/adlc/autopilot/issue-7`);
    const b = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    assert.equal(sh(repo, 'rev-parse', 'fleet/t1'), b.cutTip, 'the caller branch was reset to the new cut tip');
    assert.equal(sh(b.path, 'rev-parse', 'HEAD'), b.cutTip);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── AC 78: inside the REAL sandbox the worker can `git commit` and the object reaches the mirror ──
const backend = detectBackend();
const bwrapProbe = probeBwrap();
test('AC78 (real bwrap): a worker commit inside the bounded sandbox lands in the mirror and the host .git is invisible', { skip: bwrapProbe.ok ? false : bwrapProbe.reason }, async () => {
  const { root, repo, mirror } = mirrorFixture();
  const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'fleet-home-')));
  try {
    const a = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    const cred = join(home, 'cred.json'); writeFileSync(cred, '{}', { mode: 0o600 });
    const settings = join(home, 'settings.json'); writeFileSync(settings, '{}', { mode: 0o400 });
    const sb = new BoundedModelSandbox({
      backend, worktree: a.path, writableRoots: [mirror], readOnlyPaths: ['/usr', '/lib', '/lib64', '/etc/ssl', '/etc/resolv.conf', '/etc/hosts', '/bin'].filter((p) => existsSync(p)),
      home, homeBinds: [{ source: cred, target: join(home, '.claude', '.credentials.json') }, { source: settings, target: join(home, '.claude', 'settings.json') }, { source: join(home, '.claude', 'plugins'), target: join(home, '.claude', 'plugins') }],
      homeWritableFiles: [], homeScratchDirs: [join(home, '.claude', 'projects')], unshareNet: true,
      exec: (argv, opts) => spawnSync(argv[0], argv.slice(1), { ...opts, encoding: 'utf8' }),
    });
    const script = `set -e; echo inside > inside.txt; git -c user.name=t -c user.email=t@x -c commit.gpgsign=false add -A; git -c user.name=t -c user.email=t@x -c commit.gpgsign=false commit -q -m inside; git rev-parse HEAD; ls ${repo}/.git >/dev/null 2>&1 && echo HOSTGIT-VISIBLE || echo HOSTGIT-HIDDEN`;
    const out = await sb.run(['/bin/sh', '-c', script], { cwd: a.path, env: { PATH: '/usr/bin:/bin', HOME: home } });
    assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
    const lines = out.stdout.trim().split('\n');
    const sha = lines[0];
    assert.equal(lines[1], 'HOSTGIT-HIDDEN', 'the host .git is not visible inside');
    assert.equal(sh(mirror, 'cat-file', '-t', sha), 'commit', 'the new object exists in the MIRROR');
    const fb = mirrorFetchBack({ repo, mirror, workerBranch: a.branch, cutTip: a.cutTip, gatePath: a.gatePath, gitAt });
    assert.equal(fb.ok, true); assert.equal(fb.sha, sha);
    assert.equal(readFileSync(join(a.gatePath, 'inside.txt'), 'utf8').trim(), 'inside');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('unwrapAll helper still recovers the inner argv through the bridge prefix (test-helper contract)', () => {
  const calls = unwrapAll([{ cmd: 'bwrap', args: ['--tmpfs', '/tmp', '--', process.execPath, BRIDGE_PATH, '--socket', 's', '--port', '8118', '--', 'claude', '-p'] }]);
  assert.equal(calls[0].cmd, process.execPath);
});

test('bounded mode resolves the adapter executable on the host, binds it read-only as a single file and invokes it by that absolute path even when the caller did not list it; an unresolvable executable is sandbox-policy-mismatch (codex r5)', async () => {
  const rec = newRec();
  const io = fakeIo(rec);
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-exe-'));
  try {
    // the operator lists ONLY system roots: the executable still gets in, through the host resolution
    const deps = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'] } });
    const r = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r.exitCode, 0, r.output);
    const call = findInner(rec.spawn, `${HOME}/.local/bin/claude`);
    assert.ok(call, 'invoked by the absolute realpath, never a bare name');
    const w = call.wrapper.args;
    const pairs = w.map((a, i) => `${a} ${w[i + 1]}`);
    assert.ok(pairs.includes(`--ro-bind ${HOME}/.local/bin/claude`), 'a single-file read-only bind of the executable');
    assert.ok(!pairs.includes(`--ro-bind ${HOME}/.local/bin`), 'its parent directory is not exposed');
    const io2 = { ...fakeIo(newRec()), resolveExecutable: () => null };
    const deps2 = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io: io2, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'] } });
    const r2 = await deps2.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r2.exitCode, 1);
    assert.equal(r2.policyMismatch, true);
    assert.match(r2.output, /adapter executable not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('allowlist egress applies the executable mapping BEFORE the bridge prefix: the bridge spawns the bound absolute path (codex r6)', async () => {
  const rec = newRec();
  const io = fakeIo(rec);
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-bridge-'));
  try {
    const deps = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'], modelPlaneEgress: 'allowlist' } });
    const r = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r.exitCode, 0, r.output);
    const call = rec.spawn.find((s) => [s.cmd, ...s.args].some((a) => String(a).endsWith('egress-bridge.mjs')));
    assert.ok(call, 'the bridge wraps the worker');
    const argv = [call.cmd, ...call.args];
    const after = argv.slice(argv.lastIndexOf('--') + 1);
    assert.equal(after[0], `${HOME}/.local/bin/claude`, `the bridge target is the absolute executable: ${after.join(' ')}`);
    assert.ok(!after.includes('claude'), 'the bare name never reaches the bridge');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bounded mode accepts the documented npm/corepack DIRECTORY trees and still refuses any other non-system directory (codex r8)', async () => {
  const rec = newRec();
  const io = { ...fakeIo(rec), isFile: (p) => !/node_modules\/(npm|corepack)$/.test(p) && p !== '/opt/stuff' };
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-npm-'));
  try {
    const ok = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr', '/opt/node/lib/node_modules/npm', '/opt/node/lib/node_modules/corepack'] } });
    const r = await ok.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r.exitCode, 0, r.output);
    const call = findInner(rec.spawn, `${HOME}/.local/bin/claude`);
    const pairs = call.wrapper.args.map((a, i) => `${a} ${call.wrapper.args[i + 1]}`);
    assert.ok(pairs.includes('--ro-bind /opt/node/lib/node_modules/npm'), 'the npm tree is bound');
    const bad = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr', '/opt/stuff'] } });
    const r2 = await bad.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r2.exitCode, 1); assert.equal(r2.policyMismatch, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the credential staging directory is refused when TMPDIR resolves under the worktree (or any writable root); the node runtime is bound in bounded OPEN mode too (codex r9)', async () => {
  const rec = newRec();
  const wt = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-ext-wt-')));
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-stage-'));
  try {
    const io = fakeIo(rec); io.env = { ...io.env, TMPDIR: wt };
    const deps = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'] } });
    const r = await deps.dispatch({ ticket, worktree: wt, startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r.exitCode, 1); assert.equal(r.policyMismatch, true);
    assert.match(r.output, /staging directory .* lies under the writable root/);
    assert.deepEqual(readdirSync(wt).filter((f) => f.startsWith('fleet-home-')), [], 'nothing staged is left under the worktree');
    const rec2 = newRec();
    const io2 = fakeIo(rec2);
    const ok = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io: io2, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'] } });
    await ok.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    const call = findInner(rec2.spawn, `${HOME}/.local/bin/claude`);
    const pairs = call.wrapper.args.map((a, i) => `${a} ${call.wrapper.args[i + 1]}`);
    assert.ok(pairs.includes(`--ro-bind ${realpathSync(process.execPath)}`), 'the node runtime is a single-file bind in open (non-allowlist) bounded mode');
  } finally { rmSync(wt, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('the operator\'s --adapter-command override is the EFFECTIVE command: bound and invoked by its realpath, refused when it lies under the worktree/repository (codex r10)', async () => {
  const rec = newRec();
  const io = { ...fakeIo(rec), resolveExecutable: (c) => (c === '/opt/claude-x/bin/claude-x' ? c : c === 'claude' ? `${HOME}/.local/bin/claude` : null) };
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-override-'));
  try {
    const deps = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, adapterCommand: '/opt/claude-x/bin/claude-x', modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'] } });
    const r = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r.exitCode, 0, r.output);
    const call = findInner(rec.spawn, '/opt/claude-x/bin/claude-x');
    assert.ok(call, 'the override is what runs inside the plane');
    const pairs = call.wrapper.args.map((a, i) => `${a} ${call.wrapper.args[i + 1]}`);
    assert.ok(pairs.includes('--ro-bind /opt/claude-x/bin/claude-x'), 'and it is bound read-only');
    const io2 = { ...fakeIo(newRec()), resolveExecutable: (c) => c };
    const bad = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io: io2, config: { gate: { test: 't' }, timeoutMinutes: 1, adapterCommand: '/wt/T1/node_modules/.bin/claude', modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr'] } });
    const r2 = await bad.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r2.policyMismatch, true); assert.match(r2.output, /lies under the worktree/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mirrorFetchBack rolls the compare-and-swap BACK when the gate worktree cannot attach: ok:false step gate-worktree, the branch ref is at the cut tip again, and a retry with the same cut tip succeeds', () => {
  const { root, repo, mirror } = mirrorFixture();
  try {
    const a = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    writeFileSync(join(a.path, 'w.txt'), '1\n'); sh(a.path, 'add', '-A'); sh(a.path, 'commit', '-q', '-m', 'w1');
    let failures = 0;
    const failingGit = (dir) => (...args) => { if (args[0] === 'worktree' && args[1] === 'add') { failures++; throw new Error('disk full'); } return gitAt(dir)(...args); };
    const fb = mirrorFetchBack({ repo, mirror, workerBranch: a.branch, cutTip: a.cutTip, gatePath: a.gatePath, gitAt: failingGit });
    assert.equal(fb.ok, false); assert.equal(fb.reason, 'mirror-fetch-failed'); assert.equal(fb.step, 'gate-worktree');
    assert.match(fb.detail, /disk full.*rolled back/);
    assert.equal(failures, 1);
    assert.equal(sh(repo, 'rev-parse', a.branch), a.cutTip, 'the caller branch ref is back at the cut tip (ok:false ⇒ ref untouched)');
    assert.equal(sh(repo, 'for-each-ref', 'refs/fleet/fetched'), '', 'no temp ref lingers');
    const again = mirrorFetchBack({ repo, mirror, workerBranch: a.branch, cutTip: a.cutTip, gatePath: a.gatePath, gitAt });
    assert.equal(again.ok, true, 'the retry against the SAME cut tip lands (no wedge)');
    assert.equal(sh(repo, 'rev-parse', a.branch), again.sha);
    assert.ok(existsSync(join(a.gatePath, 'w.txt')), 'the gate worktree is attached on the fetched-back branch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a POISONED mirror is refused before any host git runs inside it: assertBareMirror throws, mirrorFetchBack returns mirror-fetch-failed step mirror-pristine with the branch untouched and no fetch, and a pristine mirror passes', () => {
  const { root, repo, mirror } = mirrorFixture();
  try {
    const a = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    writeFileSync(join(a.path, 'w.txt'), '1\n'); sh(a.path, 'add', '-A'); sh(a.path, 'commit', '-q', '-m', 'w1');
    // The worker plants a smudge filter in the mirror's config (would run as the host user on the next checkout).
    sh(mirror, 'config', '--file', join(mirror, 'config'), 'filter.evil.smudge', 'touch /tmp/pwned-by-mirror');
    const fb = mirrorFetchBack({ repo, mirror, workerBranch: a.branch, cutTip: a.cutTip, gatePath: a.gatePath, gitAt });
    assert.equal(fb.ok, false); assert.equal(fb.reason, 'mirror-fetch-failed'); assert.equal(fb.step, 'mirror-pristine');
    assert.match(fb.detail, /poisoned.*filter\.evil\.smudge/);
    assert.equal(sh(repo, 'rev-parse', a.branch), a.cutTip, 'the caller branch never moved');
    assert.equal(sh(repo, 'for-each-ref', 'refs/fleet/fetched'), '', 'no fetch was attempted');
    assert.ok(!existsSync('/tmp/pwned-by-mirror'), 'nothing executed');
    sh(mirror, 'config', '--file', join(mirror, 'config'), '--unset', 'filter.evil.smudge');
    for (const [k, v] of [['core.fsmonitor', '/tmp/evil-monitor'], ['core.hookspath', '/tmp/evil-hooks'], ['core.sshcommand', '/tmp/evil-ssh'], ['include.path', '/tmp/evil-include']]) {
      sh(mirror, 'config', '--file', join(mirror, 'config'), k, v);
      assert.throws(() => assertBareMirror({ mirror, gitAt }), /poisoned/, `${k} is refused at run start`);
      sh(mirror, 'config', '--file', join(mirror, 'config'), '--unset', k);
    }
    writeFileSync(join(mirror, 'hooks', 'post-checkout'), '#!/bin/sh\ntouch /tmp/pwned-by-hook\n');
    assert.throws(() => assertMirrorConfigPristine({ mirror, gitAt }), /poisoned: live hooks/);
    rmSync(join(mirror, 'hooks', 'post-checkout'));
    assert.ok(assertBareMirror({ mirror, gitAt }).baseBranch, 'the pristine mirror passes');
    const again = mirrorFetchBack({ repo, mirror, workerBranch: a.branch, cutTip: a.cutTip, gatePath: a.gatePath, gitAt });
    assert.equal(again.ok, true, JSON.stringify(again));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('assertWorktreeLink: a mirror worktree whose .git link was rewritten to another gitdir, replaced by a symlink, or removed is refused; the genuine link passes', async () => {
  const { assertWorktreeLink } = await import('../lib/git-mirror.mjs');
  const { symlinkSync, unlinkSync, readFileSync: rf } = await import('node:fs');
  const { root, repo, mirror } = mirrorFixture();
  try {
    const a = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    const link = join(a.path, '.git');
    const genuine = rf(link, 'utf8');
    assert.ok(assertWorktreeLink({ path: a.path, gitDirRoot: mirror }).gitdir.startsWith(realpathSync(join(mirror, 'worktrees'))), 'the genuine link points into the mirror');
    const evil = join(root, 'evil.git'); sh(root, 'init', '-q', '--bare', evil);
    writeFileSync(link, `gitdir: ${evil}\n`);
    assert.throws(() => assertWorktreeLink({ path: a.path, gitDirRoot: mirror }), /outside/, 'a link to a foreign gitdir is refused');
    writeFileSync(link, `gitdir: ${join(repo, '.git')}\n`);
    assert.throws(() => assertWorktreeLink({ path: a.path, gitDirRoot: mirror }), /outside/, 'a link to the CALLER repository is refused too');
    unlinkSync(link); symlinkSync(join(mirror, 'worktrees'), link);
    assert.throws(() => assertWorktreeLink({ path: a.path, gitDirRoot: mirror }), /not a regular file/, 'a symlinked .git is refused');
    unlinkSync(link);
    assert.throws(() => assertWorktreeLink({ path: a.path, gitDirRoot: mirror }), /missing/, 'a missing .git is refused (git would walk up to an enclosing repository)');
    writeFileSync(link, genuine);
    assert.ok(assertWorktreeLink({ path: a.path, gitDirRoot: mirror }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('assertWorktreeLink refuses a .git link redirected to a SIBLING worktree\'s gitdir (same root, different back-pointer)', async () => {
  const { assertWorktreeLink } = await import('../lib/git-mirror.mjs');
  const { readFileSync: rf } = await import('node:fs');
  const { root, repo, mirror } = mirrorFixture();
  try {
    const a = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    const b = mirrorCreateWorktree({ repo, ticketId: 'T2', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    const bLink = rf(join(b.path, '.git'), 'utf8');
    writeFileSync(join(a.path, '.git'), bLink);
    assert.throws(() => assertWorktreeLink({ path: a.path, gitDirRoot: mirror }), /belongs to/, "A's link now names B's gitdir (under the same root): refused");
    assert.ok(assertWorktreeLink({ path: b.path, gitDirRoot: mirror }), 'B itself is fine');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a second ticket\'s mirror worktree sees ONLY the base branch and its own fleet/<id>: the previous ticket\'s fleet/* branch is dropped from the mirror before the cut', () => {
  const { root, repo, mirror } = mirrorFixture();
  try {
    const a = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    writeFileSync(join(a.path, 'w.txt'), '1\n'); sh(a.path, 'add', '-A'); sh(a.path, 'commit', '-q', '-m', 'w1');
    assert.equal(mirrorFetchBack({ repo, mirror, workerBranch: a.branch, cutTip: a.cutTip, gatePath: a.gatePath, gitAt }).ok, true);
    const b = mirrorCreateWorktree({ repo, ticketId: 'T2', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    const heads = sh(mirror, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean).sort();
    assert.deepEqual(heads, ['adlc/autopilot/issue-7', 'fleet/t2'], `the mirror carries the base branch and T2 only: ${heads.join(', ')}`);
    assert.equal(sh(repo, 'rev-parse', 'fleet/t1').length, 40, "T1's branch still lives in the caller repository");
    assert.ok(b.path);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('assertWorktreeLink refuses a gitdir whose commondir was rewritten to another repository (the worker can write it; host git would use foreign objects/config)', async () => {
  const { assertWorktreeLink } = await import('../lib/git-mirror.mjs');
  const { readFileSync: rf } = await import('node:fs');
  const { root, repo, mirror } = mirrorFixture();
  try {
    const a = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    const link = assertWorktreeLink({ path: a.path, gitDirRoot: mirror });
    assert.equal(link.commondir, realpathSync(mirror));
    const cdFile = join(link.gitdir, 'commondir'); const orig = rf(cdFile, 'utf8');
    const evil = join(root, 'evil.git'); sh(root, 'init', '-q', '--bare', evil);
    writeFileSync(cdFile, `${evil}\n`);
    assert.throws(() => assertWorktreeLink({ path: a.path, gitDirRoot: mirror }), /commondir .* not/, 'a foreign commondir is refused');
    writeFileSync(cdFile, orig);
    assert.ok(assertWorktreeLink({ path: a.path, gitDirRoot: mirror }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a later ticket\'s mirror no longer holds the previous ticket\'s OBJECTS (refs dropped and pruned): the earlier worker commit is unreadable by hash inside the mirror', () => {
  const { root, repo, mirror } = mirrorFixture();
  try {
    const a = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    writeFileSync(join(a.path, 'secret-work.txt'), 'T1 output\n'); sh(a.path, 'add', '-A'); sh(a.path, 'commit', '-q', '-m', 'w1');
    const t1 = sh(a.path, 'rev-parse', 'HEAD');
    assert.equal(mirrorFetchBack({ repo, mirror, workerBranch: a.branch, cutTip: a.cutTip, gatePath: a.gatePath, gitAt }).ok, true);
    const { removeMirrorWorktree } = (() => ({ removeMirrorWorktree: null }))();
    sh(mirror, 'worktree', 'remove', '--force', a.path);
    mirrorCreateWorktree({ repo, ticketId: 'T2', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    const r = spawnSync('git', ['cat-file', '-e', `${t1}^{commit}`], { cwd: mirror, encoding: 'utf8' });
    assert.notEqual(r.status, 0, "T1's commit is gone from the mirror (pruned with its ref)");
    assert.equal(sh(repo, 'rev-parse', 'fleet/t1'), t1, 'the caller repository still holds it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bounded mode binds the FIXED system roots the host has (runtime, TLS trust store, resolver files) without the operator listing them; --model-plane-read-only extends the set; an absent root is not bound (codex r23 #2)', async () => {
  const rec = newRec();
  const present = new Set(SYSTEM_ROOTS.filter((p) => p !== '/lib64'));
  const io = { ...fakeIo(rec), pathExists: (p) => present.has(p) };
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-roots-'));
  try {
    const deps = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded' } });
    const r = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    assert.equal(r.exitCode, 0, r.output);
    const call = findInner(rec.spawn, `${HOME}/.local/bin/claude`);
    const w = call.wrapper.args;
    const pairs = w.map((a, i) => `${a} ${w[i + 1]}`);
    for (const root of ['/usr', '/lib', '/etc/ssl', '/etc/resolv.conf', '/etc/hosts']) assert.ok(pairs.includes(`--ro-bind ${root}`), `${root} is bound without being listed`);
    assert.ok(!pairs.includes('--ro-bind /lib64'), 'a root the host does not have is not bound');
    assert.ok(!pairs.includes('--ro-bind /'), 'never --ro-bind / /');
    const rec2 = newRec();
    const deps2 = buildLiveDeps({ repo: '/repo', statusDir: dir, sandboxSpec, io: { ...fakeIo(rec2), pathExists: (p) => present.has(p) }, config: { gate: { test: 't' }, timeoutMinutes: 1, modelPlaneRead: 'bounded', modelPlaneReadOnly: ['/usr', `${HOME}/.local/bin/rg`] } });
    await deps2.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
    const w2 = findInner(rec2.spawn, `${HOME}/.local/bin/claude`).wrapper.args;
    const pairs2 = w2.map((a, i) => `${a} ${w2[i + 1]}`);
    assert.equal(pairs2.filter((p) => p === '--ro-bind /usr').length, 1, 'a listed system root is bound once');
    assert.ok(pairs2.includes(`--ro-bind ${HOME}/.local/bin/rg`), 'the operator entry extends the set');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── the PRODUCTION egress wiring composed for real: bridgeArgv + egressEnv + startEgressProxy ──
const CONNECT_PROBE = `
const net = require("node:net");
const u = new URL(process.env.HTTPS_PROXY);
const s = net.connect(Number(u.port), u.hostname);
let buf = "";
s.on("connect", () => s.write("CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n"));
s.on("data", (d) => { buf += d; if (/\\r\\n\\r\\n/.test(buf)) { s.destroy(); process.exit(/^HTTP\\/1\\.[01] 403/.test(buf) ? 3 : 1); } });
s.on("error", () => process.exit(2));
setTimeout(() => process.exit(4), 10000);
`;
test('the production bridge wiring composes end to end on the host: bridgeArgv + egressEnv + a REAL startEgressProxy — a CONNECT to an unlisted host through the bridge is refused by the proxy and recorded (codex r23 F2 #2)', { timeout: 30_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'fleet-ext-wire-')));
  const socketPath = join(dir, 'proxy.sock');
  const proxy = await startEgressProxy({ socketPath, allowlist: ['api.anthropic.com:443'] });
  try {
    const port = await new Promise((resolve, reject) => { const srv = createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); srv.on('error', reject); });
    const egress = { proxy, port, socketPath, env: egressEnv(port), allowlist: [...proxy.allowlist] };
    const argv = bridgeArgv({ egress, argv: [process.execPath, '-e', CONNECT_PROBE] });
    assert.equal(argv[0], process.execPath); assert.equal(argv[1], BRIDGE_PATH);
    const res = await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...egress.env } });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`bridge run timed out; stderr: ${stderr}`)); }, 20_000);
      child.once('error', reject);
      child.once('exit', (status) => { clearTimeout(timer); resolve({ status, stderr }); });
    });
    assert.equal(res.status, 3, `the probe saw the proxy's 403 through the bridge (stderr: ${res.stderr})`);
    assert.deepEqual(proxy.refused.map((r) => r.host), ['example.com'], 'the proxy recorded the refused host');
  } finally { await proxy.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('mirrorCreateWorktree refuses to move fleet/<id> while ANOTHER worktree has it checked out (a human recovery checkout keeps its branch); a detached one is fine (codex r24 #3)', () => {
  const { root, repo, mirror } = mirrorFixture();
  const human = join(root, 'human-wt');
  try {
    const a = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    writeFileSync(join(a.path, 'w.txt'), '1\n'); sh(a.path, 'add', '-A'); sh(a.path, 'commit', '-q', '-m', 'w1');
    const fb = mirrorFetchBack({ repo, mirror, workerBranch: a.branch, cutTip: a.cutTip, gatePath: a.gatePath, gitAt });
    assert.equal(fb.ok, true);
    // Advance the integration branch PAST the fetched-back tip, so the re-cut must MOVE fleet/t1.
    const advanced = sh(repo, 'commit-tree', `${fb.sha}^{tree}`, '-p', fb.sha, '-m', 'advance');
    sh(repo, 'update-ref', 'refs/heads/adlc/autopilot/issue-7', advanced);
    sh(mirror, 'fetch', '-q', repo, '+refs/heads/adlc/autopilot/issue-7:refs/heads/adlc/autopilot/issue-7');
    // The gate worktree still holds the branch from the first cut; the re-cut would detach it
    // itself. Detach it here so the operator can check the worker branch out to look at it.
    sh(a.gatePath, 'checkout', '-q', '--detach');
    sh(repo, 'worktree', 'add', '-q', human, 'fleet/t1');
    assert.throws(() => mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt }), /checked out in .*human-wt.*refusing to move/);
    assert.equal(sh(repo, 'rev-parse', 'fleet/t1'), fb.sha, 'the branch pointer was NOT moved under the human worktree');
    sh(human, 'checkout', '-q', '--detach');
    const b = mirrorCreateWorktree({ repo, ticketId: 'T1', integrationBranch: 'adlc/autopilot/issue-7', mirror, repoGit: gitAt(repo), gitAt });
    assert.equal(b.cutTip, advanced); assert.equal(sh(repo, 'rev-parse', 'fleet/t1'), advanced, 'once detached, the re-cut proceeds and moves the branch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('assertBareMirror vets the mirror config BEFORE any other host git runs inside it, and every probe carries the host-safe overrides (agy fleet r8 c2)', () => {
  const { root, mirror } = mirrorFixture();
  try {
    const calls = [];
    const recordingGitAt = (cwd) => (...args) => { calls.push({ cwd, args }); return gitAt(cwd)(...args); };
    assertBareMirror({ mirror, gitAt: recordingGitAt });
    assert.ok(calls.length >= 3, `probes ran (${calls.length})`);
    assert.ok(calls[0].args.includes('config') && calls[0].args.includes('--file'), `the FIRST git call is the config vet, got: ${calls[0].args.join(' ')}`);
    for (const c of calls) {
      assert.equal(c.cwd, mirror);
      assert.ok(c.args.includes('core.hooksPath=/dev/null') && c.args.includes('core.fsmonitor=false') && c.args.includes('core.sshCommand=/bin/false'), `host-safe overrides on: ${c.args.join(' ')}`);
    }
    // A poisoned config is refused by that first call: no probe ever runs after it.
    sh(mirror, 'config', 'core.fsmonitor', '/tmp/evil-monitor');
    const before = calls.length;
    assert.throws(() => assertBareMirror({ mirror, gitAt: recordingGitAt }), /poisoned/);
    assert.equal(calls.length, before + 1, 'exactly the config vet ran, nothing after it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
