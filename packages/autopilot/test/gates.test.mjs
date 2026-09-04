// AC 20 (gate-spawn halves) / 122 / 135 / 141 / 149 / 157 (sandbox half) —
// the outer gate sequence: pinned order, per-gate clones, the tracking ref,
// snapshot bracketing, the sandbox argv/env, and — where bubblewrap exists —
// the REAL scripts/rails-guard-ci.mjs and scripts/mutation-gate.mjs executed
// inside the sandbox against a fixture GATE_REPO. The real-bwrap parts SKIP
// LOUDLY without `bwrap`.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectBackend } from '@adlc/fleet/lib/sandbox.mjs';
import { runOuterGates, gateOrderFromPreflight, gateArgvFor, checkGateOrder, EXPECTED_GATES, ensureTrackingRef, releaseTrackingRef, spawnInGateSandbox, ZERO_OID } from '../lib/gates.mjs';
import { createGateMirror, cloneGateRepo } from '../lib/mirror.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { makeCtx } from './helpers/gates-ctx.mjs';
import { makeRepo, addIssueWorktree, writeFiles, commitAll, git, scratch, seedRealGateFixture, seedDepsTree, REPO } from './helpers/gates-fixture.mjs';

const ISSUE = 7;
const BRANCH = `adlc/autopilot/issue-${ISSUE}`;
const PREFLIGHT = readFileSync(join(REPO, 'scripts', 'preflight.mjs'), 'utf8');
const FAKE_BWRAP = '/fake/bwrap';
const backend = detectBackend();
const bwrapSkip = backend?.name === 'bubblewrap' ? false : `SKIPPED LOUDLY: the real-bwrap gate tests need bubblewrap; host has ${backend?.name ?? 'no sandbox backend'}`;
if (bwrapSkip) console.error(`gates.test.mjs: ${bwrapSkip}`);

const chdirOf = (args) => args[args.indexOf('--chdir') + 1];
const innerOf = (args) => args.slice(args.indexOf('--') + 1);

/** A fixture whose gates are the fake bwrap: `onGate(args)` may act inside the clone and return a status. */
function fixture({ onGate = () => 0, files = {}, home = null } = {}) {
  const { root, baseOid } = makeRepo({ files: { 'scripts/preflight.mjs': PREFLIGHT, 'packages/foo/lib/x.mjs': 'export const x = 1;\n', ...files } });
  git(root, ['remote', 'add', 'origin', 'git@github.com:o/r.git']);
  const gates = [];
  const ctx = makeCtx({ repoRoot: root, baseOid, home, pinned: { bwrap: FAKE_BWRAP }, handlers: { [FAKE_BWRAP]: async (args, opts) => { gates.push({ exe: opts.exe, args, cwd: opts.cwd, env: opts.env }); return { status: await onGate(args, opts) }; } } });
  const wt = addIssueWorktree(root, ctx.paths.issueWorktree(ISSUE), ISSUE, baseOid);
  writeFiles(wt, { 'packages/foo/lib/x.mjs': 'export const x = 2;\n' });
  const attestedHead = commitAll(wt, 'worker + attest');
  const deps = join(ctx.paths.runDir(ISSUE), 'gate-deps', 'node_modules'); mkdirSync(deps, { recursive: true });
  const run = (over = {}) => runOuterGates({ ctx, issue: ISSUE, attestedHead, baseOid, gateDepsNodeModules: deps, backend: { name: 'bubblewrap', platform: 'linux' }, ...over });
  const prepare = () => createGateMirror({ ctx, issue: ISSUE, attestedHead, baseOid });
  return { root, baseOid, ctx, wt, attestedHead, deps, gates, run, prepare, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function ac20_gateSpawnsCarryBaseOid() {
  const f = fixture();
  try {
    await f.prepare();
    const r = await f.run();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(f.gates.map((g) => innerOf(g.args).slice(1)), [
      ['scripts/run-tests.mjs'], ['scripts/rails-guard-ci.mjs', `refs/remotes/origin/${f.baseOid}`], ['scripts/mutation-gate.mjs', `refs/remotes/origin/${f.baseOid}`, '--max', '12'],
      ['scripts/scan-findings-ledger.mjs'], ['scripts/guard-findings-ledger-append-only.mjs', `refs/remotes/origin/${f.baseOid}`], ['scripts/check-reviewer-directed-comments.mjs', `refs/remotes/origin/${f.baseOid}`],
    ], 'every individually invoked gate carries the recorded baseOid verbatim, in the pinned order');
    assert.ok(f.gates.every((g) => innerOf(g.args)[0] === f.ctx.pinned.node), 'each gate runs the pinned node');
    assert.equal(f.gates.some((g) => g.args.includes('scripts/preflight.mjs')), false, 'no scripts/preflight.mjs spawn without the R13 flags');
    f.gates.length = 0;
    const r13 = await f.run({ scriptText: PREFLIGHT + '\n// R13 fixture: --no-fetch --sandboxed\n' });
    assert.equal(r13.ok, true);
    assert.equal(f.gates.length, 1, 'with R13 the script itself is the ONE gate');
    assert.deepEqual(innerOf(f.gates[0].args).slice(1), ['scripts/preflight.mjs', '--no-fetch', '--sandboxed', '--base-oid', f.baseOid]);
    assert.ok(f.gates[0].exe === FAKE_BWRAP && f.gates[0].args.includes('--unshare-net'), 'and it runs inside the repo-command sandbox');
  } finally { f.cleanup(); }
}
test('AC20: every gate spawn carries refs/remotes/origin/<baseOid> in the pinned order and preflight.mjs is spawned only with the R13 flags', ac20_gateSpawnsCarryBaseOid);

export async function ac122_bracket() {
  let rewrite = null;
  const f = fixture({ onGate: () => { if (rewrite) { git(f.root, ['remote', 'set-url', 'origin', rewrite]); rewrite = null; } return 0; } });
  try {
    await f.prepare();
    assert.equal((await f.run()).ok, true, 'unchanged URLs and object → the pass is honoured');
    rewrite = 'git@github.com:evil/other.git';
    const moved = await f.run();
    assert.equal(moved.ok, false); assert.equal(moved.code, 'remote-url-changed', 'the result is discarded when the observed remote URL changed across the sequence');
    git(f.root, ['remote', 'set-url', 'origin', 'git@github.com:o/r.git']);
    // An object-store fake: after the gates ran, <baseOid> no longer resolves.
    const real = f.ctx.git.local; let gone = false;
    f.ctx.git.local = (cwd, args, o) => (gone && args[0] === 'cat-file' ? Promise.resolve({ status: 1, stdout: '', stderr: 'missing' }) : real(cwd, args, o));
    const withVanish = await runOuterGates({ ctx: f.ctx, issue: ISSUE, attestedHead: f.attestedHead, baseOid: f.baseOid, gateDepsNodeModules: f.deps, backend: { name: 'bubblewrap', platform: 'linux' }, scriptText: (gone = false, PREFLIGHT) });
    assert.equal(withVanish.ok, true, 'control');
    const orig = f.ctx.spawn;
    f.ctx.spawn = (req) => { if (req.argv[0] === FAKE_BWRAP) gone = true; return orig(req); };
    const vanished = await f.run();
    assert.equal(vanished.ok, false); assert.equal(vanished.code, 'base-object-missing');
  } finally { f.cleanup(); }
}
test('AC122: the gate sequence is bracketed — a remote URL rewritten during it → remote-url-changed, a base object that no longer resolves → base-object-missing, unchanged → honoured', ac122_bracket);

export async function ac135_trackingRefVerified() {
  const seen = [];
  let move = null;
  const f = fixture({ onGate: (args) => { const clone = chdirOf(args); seen.push(git(clone, ['rev-parse', `refs/remotes/origin/${f.baseOid}`])); if (move) git(clone, ['update-ref', `refs/remotes/origin/${f.baseOid}`, move]); return 0; } });
  try {
    await f.prepare();
    const ok = await f.run();
    assert.equal(ok.ok, true); assert.ok(seen.length === 6 && seen.every((v) => v === f.baseOid), 'inside every clone the tracking ref equals baseOid before the gate runs');
    assert.ok(f.gates.every((g) => innerOf(g.args).some((a) => a === `refs/remotes/origin/${f.baseOid}`) || !innerOf(g.args).some((a) => a.startsWith('refs/'))), 'the base argument is the 40-hex OID ref');
    for (const g of f.gates) assert.equal(existsSync(chdirOf(g.args)), false, 'each clone (and its ref) is removed afterwards');
    move = f.attestedHead; f.gates.length = 0;
    const moved = await f.run();
    assert.equal(moved.ok, false); assert.equal(moved.code, 'gate-repo-moved'); assert.equal(moved.reason, 'base-ref-moved');
    assert.equal(f.gates.length, 1, 'the result is discarded and no later gate runs');
    // The ref primitives on a plain repository.
    const { created } = await ensureTrackingRef({ ctx: f.ctx, cwd: f.root, baseOid: f.baseOid });
    assert.equal(created, true); assert.equal(git(f.root, ['rev-parse', `refs/remotes/origin/${f.baseOid}`]), f.baseOid);
    await releaseTrackingRef({ ctx: f.ctx, cwd: f.root, baseOid: f.baseOid, created });
    assert.throws(() => git(f.root, ['rev-parse', '--verify', `refs/remotes/origin/${f.baseOid}`]), 'deleted afterwards');
  } finally { f.cleanup(); }
}
test('AC135: refs/remotes/origin/<baseOid> equals baseOid inside every clone before its gate; a gate that moves it → gate-repo-moved (base-ref-moved), verdict discarded; the ref goes away with the clone', ac135_trackingRefVerified);

export async function ac141_trackingRefNeverClobbered() {
  const f = fixture();
  try {
    const ref = `refs/remotes/origin/${f.baseOid}`;
    git(f.root, ['update-ref', ref, f.baseOid]);
    const untouched = await ensureTrackingRef({ ctx: f.ctx, cwd: f.root, baseOid: f.baseOid });
    assert.equal(untouched.created, false);
    await releaseTrackingRef({ ctx: f.ctx, cwd: f.root, baseOid: f.baseOid, created: untouched.created });
    assert.equal(git(f.root, ['rev-parse', ref]), f.baseOid, 'a pre-existing equal ref survives the bracket');
    git(f.root, ['update-ref', ref, f.attestedHead]);
    f.ctx.recorder.length = 0;
    await assert.rejects(() => ensureTrackingRef({ ctx: f.ctx, cwd: f.root, baseOid: f.baseOid }), (e) => e.code === 'base-ref-conflict' && e.exitCode === 2, 'GateRepoError carries exitCode 2 (cli.mjs contract: 1 operational / 2 gate)');
    assert.equal(f.ctx.recorder.filter((s) => s.argv[0] === FAKE_BWRAP).length, 0, 'zero gate spawns');
    assert.equal(git(f.root, ['rev-parse', ref]), f.attestedHead, 'the different value is never clobbered');
    git(f.root, ['update-ref', '-d', ref]);
    f.ctx.recorder.length = 0;
    const made = await ensureTrackingRef({ ctx: f.ctx, cwd: f.root, baseOid: f.baseOid });
    assert.equal(made.created, true);
    assert.deepEqual(f.ctx.recorder.at(-1).argv.slice(1), ['update-ref', ref, f.baseOid, ZERO_OID], 'created with the zero-OID compare-and-swap');
    await releaseTrackingRef({ ctx: f.ctx, cwd: f.root, baseOid: f.baseOid, created: true });
    assert.deepEqual(f.ctx.recorder.at(-1).argv.slice(1), ['update-ref', '-d', ref, f.baseOid]);
    // A ref that appears between the read and the create.
    const real = f.ctx.git.local;
    f.ctx.git.local = async (cwd, args, o) => { const r = await real(cwd, args, o); if (args[0] === 'rev-parse' && r.status !== 0) git(f.root, ['update-ref', ref, f.attestedHead]); return r; };
    await assert.rejects(() => ensureTrackingRef({ ctx: f.ctx, cwd: f.root, baseOid: f.baseOid }), (e) => e.code === 'base-ref-conflict' && e.exitCode === 2, 'GateRepoError carries exitCode 2 (cli.mjs contract: 1 operational / 2 gate)');
    assert.equal(git(f.root, ['rev-parse', ref]), f.attestedHead, 'the racing value is left in place');
  } finally { f.cleanup(); }
}
test('AC141: an equal pre-existing tracking ref is untouched and survives; a different one → base-ref-conflict with zero gate spawns; an absent one is created with the zero-OID CAS and deleted with update-ref -d <ref> <oid>; a ref appearing between read and create → base-ref-conflict', ac141_trackingRefNeverClobbered);

export async function ac149_gatesSandboxedArgv() {
  const home = scratch('ap-home-'); writeFiles(home, { '.claude/.credentials.json': '{}' });
  const refsSeen = []; let plant = null;
  const f = fixture({ home, onGate: (args) => { const c = chdirOf(args); refsSeen.push({ clone: c, refs: git(c, ['for-each-ref', '--format=%(refname) %(objectname)']) }); if (plant) { plant(c); plant = null; } return 0; } });
  try {
    writeFiles(f.root, { '.env.local': 'ADLC_MANIFEST_KEY=x' });
    await f.prepare();
    assert.equal((await f.run()).ok, true);
    const forbidden = [home, join(f.root, '.git'), f.ctx.paths.mirror(ISSUE), f.ctx.paths.gateMirror(ISSUE), join(f.root, '.env.local'), f.root, f.wt, '/run/user/1000/ssh-agent'];
    for (const g of f.gates) {
      const clone = chdirOf(g.args);
      assert.equal(g.exe, FAKE_BWRAP, 'wrapped in the pinned bwrap'); assert.ok(g.args.includes('--unshare-net'), '--unshare-net'); assert.equal(g.cwd, clone, 'cwd = GATE_REPO');
      assert.ok(clone.startsWith(join(f.ctx.paths.runDir(ISSUE), 'gate-repo-')));
      assert.ok(g.args.some((a, i) => a === '--bind' && g.args[i + 1] === clone && g.args[i + 2] === clone), 'the clone is bound');
      assert.ok(g.args.some((a, i) => a === '--ro-bind' && g.args[i + 1] === f.deps && g.args[i + 2] === join(clone, 'node_modules')), 'gate-deps/node_modules bound read-only at <clone>/node_modules');
      assert.ok(g.args.some((a, i) => a === '--dev' && g.args[i + 1] === '/dev'), '/dev is provided (git needs /dev/null)');
      for (const p of forbidden) assert.ok(!g.args.includes(p), `no bind of ${p}`);
      for (const k of ['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'ADLC_MANIFEST_KEY']) assert.equal(g.env[k], undefined, `env lacks ${k}`);
      assert.ok(g.env.HOME.startsWith(join(f.ctx.paths.runDir(ISSUE), 'gate-home-')), 'synthetic empty HOME');
    }
    assert.equal(new Set(refsSeen.map((r) => r.clone)).size, 6, 'six gates, six distinct clone paths');
    const expected = `refs/heads/${BRANCH} ${f.attestedHead}\nrefs/remotes/origin/${f.baseOid} ${f.baseOid}`;
    assert.ok(refsSeen.every((r) => r.refs === expected), "every clone's for-each-ref equals the mirror's two refs");
    for (const [what, act, reason] of [
      ['commits inside its clone', (c) => { writeFiles(c, { 'planted.txt': 'x\n' }); commitAll(c, 'planted'); }, 'head-moved'],
      ['rewrites the base ref without moving HEAD', (c) => git(c, ['update-ref', `refs/remotes/origin/${f.baseOid}`, f.attestedHead]), 'base-ref-moved'],
      ['adds .git/hooks/pre-commit', (c) => { writeFileSync(join(c, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n', { mode: 0o755 }); }, 'hooks-added'],
      ['plants a ref', (c) => git(c, ['update-ref', 'refs/heads/planted', f.attestedHead]), 'refs-changed'],
    ]) {
      plant = act; f.gates.length = 0;
      const r = await f.run();
      assert.equal(r.code, 'gate-repo-moved', what); assert.equal(r.reason, reason, what); assert.equal(f.gates.length, 1, `${what}: the run fails at that gate`);
    }
    const reordered = PREFLIGHT.replace("name: 'rail-freeze'", "name: 'rail-freeze-x'");
    const drift = await f.run({ scriptText: reordered });
    assert.equal(drift.code, 'preflight-order-drift'); assert.equal(f.gates.length, 1, 'no gate spawned for a drifted order (count unchanged)');
    const parsed = gateOrderFromPreflight(PREFLIGHT);
    assert.equal(checkGateOrder(parsed).ok, true); assert.equal(checkGateOrder([parsed[1], parsed[0], ...parsed.slice(2)]).code, 'preflight-order-drift', 'a reordered list');
    assert.equal(parsed.length, EXPECTED_GATES.length);
  } finally { f.cleanup(); rmSync(home, { recursive: true, force: true }); }
}
test('AC149: every gate is wrapped in bwrap with --unshare-net, a bind of GATE_REPO, the read-only deps bind and no bind of $HOME/.env.local/.git/mirror; env lacks SSH_AUTH_SOCK/GH_TOKEN/GITHUB_TOKEN/ADLC_MANIFEST_KEY; distinct clones with the mirror\'s refs; a gate that commits, moves the base ref, adds a hook or plants a ref → gate-repo-moved; a reordered list → preflight-order-drift', ac149_gatesSandboxedArgv);

// ---- real bubblewrap --------------------------------------------------------------------

function realFixture() {
  const root = scratch('ap-real-'); seedRealGateFixture(root);
  git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'gc.auto', '0']); git(root, ['config', 'gc.autoDetach', 'false']); const baseOid = commitAll(root, 'base');
  const home = scratch('ap-real-home-'); writeFiles(home, { '.claude/.credentials.json': '{"secret":1}' });
  const ctx = makeCtx({ repoRoot: root, baseOid, home });
  writeFiles(root, { '.env.local': 'ADLC_MANIFEST_KEY=hostkey' });
  const wt = addIssueWorktree(root, ctx.paths.issueWorktree(ISSUE), ISSUE, baseOid);
  const depsRoot = scratch('ap-real-deps-'); const deps = seedDepsTree(depsRoot);
  mkdirSync(join(deps, '.bin')); writeFileSync(join(deps, '.bin', 'adlc'), '#!/bin/sh\necho adlc\n', { mode: 0o755 });
  const headWith = (files, msg) => { git(wt, ['reset', '-q', '--hard', baseOid]); writeFiles(wt, files); return commitAll(wt, msg); };
  const hostRun = (head, argv) => { // the same script on the host, against a host clone with the same tracking ref
    const dir = scratch('ap-host-'); git(dir, ['clone', '-q', '--no-hardlinks', '-b', BRANCH, root, '.']); git(dir, ['reset', '-q', '--hard', head]); git(dir, ['update-ref', `refs/remotes/origin/${baseOid}`, baseOid]); seedDepsTree(dir);
    try { execFileSync(argv[0], argv.slice(1), { cwd: dir, stdio: 'pipe', env: { PATH: process.env.PATH, HOME: home } }); return { status: 0, out: '' }; }
    catch (e) { return { status: e.status ?? 1, out: `${e.stdout}\n${e.stderr}`.slice(-600) }; } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const inSandbox = async (head, inner, k = 9) => {
    await createGateMirror({ ctx, issue: ISSUE, attestedHead: head, baseOid });
    const clone = await cloneGateRepo({ ctx, issue: ISSUE, k, attestedHead: head, baseOid });
    try { return await spawnInGateSandbox({ ctx, clone, inner, nodeModules: deps, backend, home: join(ctx.paths.runDir(ISSUE), `gate-home-${k}`), label: 'probe', deadlineMs: 600_000 }); }
    finally { rmSync(clone, { recursive: true, force: true }); }
  };
  return { root, baseOid, ctx, wt, deps, home, headWith, hostRun, inSandbox, cleanup: () => { for (const d of [root, home, depsRoot]) rmSync(d, { recursive: true, force: true }); } };
}
const RAILS = (oid) => [process.execPath, 'scripts/rails-guard-ci.mjs', `refs/remotes/origin/${oid}`];
const MUTATION = (oid) => [process.execPath, 'scripts/mutation-gate.mjs', `refs/remotes/origin/${oid}`, '--max', '12'];

export async function ac149_realBwrapGates() {
  const f = realFixture();
  try {
    const clean = f.headWith({ 'packages/foo/lib/x.mjs': 'export function add(a, b) { return a + b; }\nexport function gt(a, b) { return a > b; }\n', 'packages/foo/test/x.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, gt } from '../lib/x.mjs';\ntest('add', () => { assert.equal(add(1, 2), 3); });\ntest('gt', () => { assert.equal(gt(2, 1), true); assert.equal(gt(1, 2), false); assert.equal(gt(1, 1), false); });\n" }, 'clean');
    await createGateMirror({ ctx: f.ctx, issue: ISSUE, attestedHead: clean, baseOid: f.baseOid });
    const all = await runOuterGates({ ctx: f.ctx, issue: ISSUE, attestedHead: clean, baseOid: f.baseOid, gateDepsNodeModules: f.deps });
    assert.equal(all.ok, true, JSON.stringify(all.gates.map((g) => [g.name, g.status, g.output.slice(-400)])));
    assert.deepEqual(all.gates.map((g) => g.name), EXPECTED_GATES.map((g) => g.name), 'the real sequence in the pinned order, every gate green');
    const hostRails = f.hostRun(clean, RAILS(f.baseOid)); assert.equal(hostRails.status, 0, `host rails-guard on the clean head: ${hostRails.out}`);
    const hostMut = f.hostRun(clean, MUTATION(f.baseOid)); assert.equal(hostMut.status, 0, `host mutation-gate on the clean head: ${hostMut.out}`);
    const trustRoot = f.headWith({ 'scripts/rails-guard-ci.mjs': readFileSync(join(f.root, 'scripts', 'rails-guard-ci.mjs'), 'utf8') + '\n// planted trust-root edit\n' }, 'trust-root edit');
    const railsIn = await f.inSandbox(trustRoot, RAILS(f.baseOid), 1);
    assert.equal(railsIn.status, 2, `rails-guard inside the sandbox denies the planted trust-root edit: ${railsIn.stderr.slice(-300)}`); assert.equal(f.hostRun(trustRoot, RAILS(f.baseOid)).status, 2, 'same verdict on the host');
    const hollow = f.headWith({ 'packages/foo/lib/x.mjs': 'export function add(a, b) { return a + b; }\nexport function gt(a, b) { return a > b; }\n', 'packages/foo/test/x.test.mjs': "import { test } from 'node:test';\nimport { add, gt } from '../lib/x.mjs';\ntest('hollow', () => { add(1, 2); gt(1, 2); });\n" }, 'surviving mutant');
    const mutIn = await f.inSandbox(hollow, MUTATION(f.baseOid), 2);
    assert.equal(mutIn.status, 2, `mutation-gate inside the sandbox reports the surviving mutant: ${mutIn.stdout.slice(-400)}`); assert.equal(f.hostRun(hollow, MUTATION(f.baseOid)).status, 2, 'same verdict on the host');
    const probe = await f.inSandbox(clean, [process.execPath, '-e', `
      const fs = require('node:fs'); const out = {};
      out.gitDir = require('node:child_process').spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).stdout.trim();
      out.cwd = process.cwd();
      for (const [k, p] of [['cred', ${JSON.stringify(join(f.home, '.claude', '.credentials.json'))}], ['homeCred', require('node:path').join(process.env.HOME, '.claude', '.credentials.json')], ['envLocal', ${JSON.stringify(join(f.root, '.env.local'))}], ['hostGit', ${JSON.stringify(join(f.root, '.git', 'config'))}]]) {
        try { fs.readFileSync(p); out[k] = 'READ'; } catch (e) { out[k] = e.code; }
      }
      const s = require('node:net').connect(443, '1.1.1.1'); s.on('error', (e) => { out.net = e.code; done(); }); s.on('connect', () => { out.net = 'CONNECTED'; done(); });
      function done() { console.log(JSON.stringify(out)); process.exit(0); }
    `], 3);
    const seen = JSON.parse(probe.stdout.trim().split('\n').pop());
    assert.equal(seen.gitDir, '.git', 'git rev-parse --git-dir resolves inside GATE_REPO'); assert.ok(seen.cwd.includes('gate-repo-3'));
    assert.equal(seen.cred, 'ENOENT', "the operator's ~/.claude/.credentials.json is not visible"); assert.equal(seen.homeCred, 'ENOENT', 'nor under the synthetic HOME');
    assert.equal(seen.envLocal, 'ENOENT', '.env.local is not visible'); assert.equal(seen.hostGit, 'ENOENT', 'the host .git is not visible');
    assert.notEqual(seen.net, 'CONNECTED', `no network (${seen.net})`);
    // A gate that commits inside its clone → gate-repo-moved, verdict discarded.
    const committing = f.headWith({ 'scripts/run-tests.mjs': "#!/usr/bin/env node\nimport { execFileSync } from 'node:child_process';\nexecFileSync('git', ['-c', 'user.email=g@x', '-c', 'user.name=g', 'commit', '-q', '--allow-empty', '-m', 'from-gate']);\n" }, 'committing gate');
    await createGateMirror({ ctx: f.ctx, issue: ISSUE, attestedHead: committing, baseOid: f.baseOid });
    const moved = await runOuterGates({ ctx: f.ctx, issue: ISSUE, attestedHead: committing, baseOid: f.baseOid, gateDepsNodeModules: f.deps });
    assert.equal(moved.code, 'gate-repo-moved'); assert.equal(moved.reason, 'head-moved'); assert.equal(moved.gate, 'tests');
  } finally { f.cleanup(); }
}
test('AC149 (real bwrap): the REAL rails-guard-ci and mutation-gate run inside the sandbox against a fixture GATE_REPO with the same verdicts as the host — a planted trust-root edit and a surviving mutant are caught — credentials, .env.local, the host .git and the network are unreachable, and a gate that commits → gate-repo-moved', { skip: bwrapSkip }, ac149_realBwrapGates);

export async function ac157_sandboxDepsResolve() {
  const f = realFixture();
  try {
    const head = f.headWith({ 'packages/foo/lib/x.mjs': 'export const x = 7;\n' }, 'deps probe');
    const probe = await f.inSandbox(head, [process.execPath, '-e', `
      const fs = require('node:fs'); const out = {};
      import('@adlc/foo/lib/x.mjs').then((m) => { out.x = m.x; }).catch((e) => { out.x = e.code; }).then(() => {
        out.viaNodeModules = fs.realpathSync('node_modules/@adlc/foo').startsWith(process.cwd());
        try { fs.writeFileSync('node_modules/@adlc/planted', 'x'); out.write = 'WROTE'; } catch (e) { out.write = e.code; }
        try { fs.accessSync('node_modules/.bin/adlc', fs.constants.X_OK); out.bin = 'ok'; } catch (e) { out.bin = e.code; }
        console.log(JSON.stringify(out));
      });
    `], 4);
    const seen = JSON.parse(probe.stdout.trim().split('\n').pop());
    assert.equal(seen.x, 7, 'a workspace package imports through <clone>/node_modules/@adlc/<x>');
    assert.equal(seen.viaNodeModules, true, 'the workspace link resolves INSIDE the clone');
    assert.equal(seen.write, 'EROFS', 'a write into the bound tree fails EROFS');
    assert.equal(seen.bin, 'ok', 'node_modules/.bin resolves');
    const missing = await runOuterGates({ ctx: f.ctx, issue: ISSUE, attestedHead: head, baseOid: f.baseOid, gateDepsNodeModules: join(f.deps, 'absent') });
    assert.equal(missing.code, 'gate-deps-missing'); assert.equal(missing.gates.length, 0, 'no gate runs, no attestation');
  } finally { f.cleanup(); }
}
test('AC157 (real bwrap): inside the sandbox a workspace import through <clone>/node_modules/@adlc/<x> resolves inside the clone, a write into it fails EROFS, node_modules/.bin resolves; a missing gate-deps tree → gate-deps-missing before any gate', { skip: bwrapSkip }, ac157_sandboxDepsResolve);

test('seam check: the gates tests fail under their registered seams', async () => {
  const pairs = [['gates.spawnPreflightAlways', ac20_gateSpawnsCarryBaseOid], ['gates.skipBracket', ac122_bracket], ['gates.skipSnapshotCheck', ac135_trackingRefVerified], ['gates.clobberTrackingRef', ac141_trackingRefNeverClobbered], ['gates.allowNetwork', ac149_gatesSandboxedArgv]];
  if (!bwrapSkip) pairs.push(['gates.skipSnapshotCheck', ac149_realBwrapGates], ['gates.skipDepsBind', ac157_sandboxDepsResolve]);
  for (const [seam, fn] of pairs) await assert.rejects(() => withMutation(seam, fn), `${fn.name} must fail under ${seam}`);
});

export async function ac149_gateMetadataCheckedBeforeHostGit() {
  const { writeFileSync: wf, chmodSync: cm } = await import('node:fs');
  const { HOST_SAFE_GIT } = await import('../lib/gate-repo.mjs');
  const f = fixture({ onGate: (args, opts) => {
    // The gate plants an fs-monitor command and a hook inside the clone's .git.
    const clone = opts.cwd; wf(join(clone, '.git', 'config'), `${readFileSync(join(clone, '.git', 'config'), 'utf8')}[core]\n\tfsmonitor = /tmp/evil-monitor\n`);
    wf(join(clone, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch /tmp/pwned-by-gate\n'); cm(join(clone, '.git', 'hooks', 'post-checkout'), 0o755);
    return 0;
  } });
  try {
    await f.prepare();
    const gitBefore = f.ctx.recorder.length;
    const r = await f.run();
    assert.equal(r.ok, false); assert.equal(r.code, 'gate-repo-moved'); assert.equal(r.reason, 'config-changed', JSON.stringify(r));
    const clone = f.gates[0]?.cwd; assert.ok(clone, 'the gate ran in a clone');
    const gateIdx = f.ctx.recorder.findIndex((x) => x.argv[0] === FAKE_BWRAP);
    const inClone = f.ctx.recorder.slice(gateIdx + 1).filter((x) => /(^|\/)git$/.test(String(x.argv[0])) && String(x.cwd ?? '') === clone);
    assert.equal(inClone.length, 0, `no host git ran inside the tampered clone after the gate: ${JSON.stringify(inClone.map((x) => x.argv.slice(0, 4)))}`);
    assert.ok(!existsSync('/tmp/pwned-by-gate'));
    // And every host git that DOES run in a clone carries the host-safe overrides.
    const clean = fixture();
    try {
      await clean.prepare(); const ok = await clean.run(); assert.equal(ok.ok, true, JSON.stringify(ok));
      // Only git that runs in a clone AFTER a gate executed IN THAT clone is exposed to the gate's edits.
      const rec = clean.ctx.recorder;
      const gits = [];
      for (const g of ok.gates ?? []) {
        const gateIdx = rec.findIndex((x) => x.argv[0] === FAKE_BWRAP && JSON.stringify(x.argv).includes(g.clone));
        assert.ok(gateIdx >= 0, `the gate ran in ${g.clone}`);
        gits.push(...rec.slice(gateIdx + 1).filter((x) => /(^|\/)git$/.test(String(x.argv[0])) && String(x.cwd ?? '') === g.clone));
      }
      assert.ok(gits.length > 0, 'host git ran in the clone');
      for (const g of gits) assert.deepEqual(g.argv.slice(1, 1 + HOST_SAFE_GIT.length), [...HOST_SAFE_GIT], `host-safe overrides lead: ${g.argv.slice(0, 8).join(' ')}`);
    } finally { clean.cleanup(); }
  } finally { f.cleanup(); }
}
test('AC149: a gate that touches the clone\'s .git config or hooks is refused by a FILE-level check before any host git runs inside that clone, and every host git in a clone carries the host-safe overrides', ac149_gateMetadataCheckedBeforeHostGit);

test('AC122: GatesError carries the documented exitCode contract (1 operational / 2 gate) at every throw site — gateOrderFromPreflight (unparseable preflight) and gateArgvFor (a non-node gate argv)', () => {
  for (const [bad, code] of [['no buildGates() at all', 'preflight-unparseable'], ['function buildGates() { return [', 'preflight-unparseable']]) {
    assert.throws(() => gateOrderFromPreflight(bad), (e) => e.code === code && e.exitCode === 2, code);
  }
  assert.throws(() => gateArgvFor({ name: 'x', argv: ['bash', '-c', 'evil'] }, { node: '/pinned/node', baseOid: 'a'.repeat(40) }), (e) => e.code === 'preflight-order-drift' && e.exitCode === 2);
});
