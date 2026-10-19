// rails-guard-no-root.test.mjs — a preToolUse payload that names no workspace
// root must never be checked against the hook process cwd (#815).
//
// Cursor runs the hook as `node ./hooks/adlc-pretool.mjs`, so the process cwd is
// the PLUGIN directory, which has no ticket store. Resolving against it made the
// guard read "repo not ADLC-initialized" and allow a frozen-rail edit silently.
// The root now comes from the payload, then CURSOR_PROJECT_DIR, and otherwise is
// unresolved: deny under ADLC_P4_ENFORCEMENT=1, allow plus a notice without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tmp } from '@adlc/core/test-kit';
import { decide, resolveOwning, resolveRoot, candidateRoots } from '../hooks/adlc-rails-guard.mjs';
import { dispatch } from '../hooks/adlc-pretool.mjs';
import { audit, flailCheck } from '../hooks/adlc-audit.mjs';
import { spawnHook } from './helpers/run-hook.mjs';
import { RECENT_EDITS_FILE } from '../constants.mjs';
import { sessionSafeId } from '../lib/session-identity.mjs';
import { DEFAULT_DEPTH_THRESHOLD } from '@adlc/build-gate/lib/depth-signal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, '..');
const PRETOOL = join(PLUGIN_DIR, 'hooks', 'adlc-pretool.mjs');
const FIXTURE = join(HERE, 'fixtures', 'pretool-edit-no-root.json');
const UNRESOLVED = /workspace root could not be resolved/;

/** A repo with ticket T1 railing src/frozen.js. Returns its realpath. */
function railedRepo(t) {
  const root = realpathSync(tmp(t, 'adlc-cursor-noroot-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({
    tickets: [{ id: 'T1', title: 'one', rails: ['src/frozen.js'] }],
  }));
  writeFileSync(join(root, 'src', 'frozen.js'), 'export const x = 1;\n');
  return root;
}

/** The checked-in no-root fixture, pointed at an absolute file. */
function noRootPayload(file) {
  const raw = readFileSync(FIXTURE, 'utf8').replace('__FILE__', file);
  return JSON.parse(raw);
}

/** A hermetic hook env: nothing inherited but PATH. */
function hookEnv(t, over = {}) {
  const home = realpathSync(tmp(t, 'adlc-cursor-noroot-home-'));
  return { PATH: process.env.PATH, HOME: home, ADLC_CURSOR_STATE_DIR: join(home, 'state'), ...over };
}

function runPretool(t, payload, env) {
  const r = spawnHook([PRETOOL], { cwd: PLUGIN_DIR, input: JSON.stringify(payload), env, encoding: 'utf8' });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  return { verdict: JSON.parse(r.stdout), stderr: r.stderr };
}

test('the fixture carries no workspace root key', () => {
  const p = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  for (const k of ['workspace_roots', 'workspaceRoots', 'workspace_root', 'workspaceRoot', 'project_root', 'projectRoot', 'cwd', 'root']) {
    assert.equal(k in p, false, `fixture must not carry ${k}`);
  }
});

test('AC1 shipped hook, cwd = plugin dir, no root, no CURSOR_PROJECT_DIR, enforcement on: denied as unresolved', (t) => {
  const repo = railedRepo(t);
  const { verdict } = runPretool(t, noRootPayload(join(repo, 'src', 'frozen.js')),
    hookEnv(t, { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' }));
  assert.equal(verdict.permission, 'deny');
  assert.match(verdict.user_message, UNRESOLVED);
  assert.match(verdict.agent_message, /CURSOR_PROJECT_DIR/);
});

test('AC1 an unresolved root denies even a path that is not a rail (nothing can be verified)', (t) => {
  const repo = railedRepo(t);
  const { verdict } = runPretool(t, noRootPayload(join(repo, 'src', 'free.js')),
    hookEnv(t, { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' }));
  assert.equal(verdict.permission, 'deny');
  assert.match(verdict.user_message, UNRESOLVED);
});

test('AC2 the same payload with CURSOR_PROJECT_DIR = the repo is denied for the frozen rail', (t) => {
  const repo = railedRepo(t);
  const { verdict } = runPretool(t, noRootPayload(join(repo, 'src', 'frozen.js')),
    hookEnv(t, { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', CURSOR_PROJECT_DIR: repo }));
  assert.equal(verdict.permission, 'deny');
  assert.match(verdict.user_message, /frozen rail "src\/frozen\.js"/);
  assert.doesNotMatch(verdict.user_message, UNRESOLVED);
});

test('AC2 CURSOR_PROJECT_DIR resolves a RELATIVE path against the project dir', (t) => {
  const repo = railedRepo(t);
  const { verdict } = runPretool(t, noRootPayload('src/frozen.js'),
    hookEnv(t, { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', CURSOR_PROJECT_DIR: repo }));
  assert.equal(verdict.permission, 'deny');
  assert.match(verdict.user_message, /frozen rail "src\/frozen\.js"/);
});

test('AC2 CURSOR_PROJECT_DIR + a non-rail path is allowed', (t) => {
  const repo = railedRepo(t);
  const { verdict, stderr } = runPretool(t, noRootPayload(join(repo, 'src', 'free.js')),
    hookEnv(t, { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', CURSOR_PROJECT_DIR: repo }));
  assert.deepEqual(verdict, { permission: 'allow' });
  assert.doesNotMatch(stderr, UNRESOLVED);
});

test('AC3 no enforcement, no resolvable root: allow plus exactly one stderr notice', (t) => {
  const repo = railedRepo(t);
  const payload = noRootPayload(join(repo, 'src', 'frozen.js'));
  payload.tool_input = { ...payload.tool_input, edits: [{ file_path: join(repo, 'src', 'other.js') }] };
  const { verdict, stderr } = runPretool(t, payload, hookEnv(t, { ADLC_TICKET: 'T1' }));
  assert.deepEqual(verdict, { permission: 'allow' });
  const notices = stderr.split('\n').filter((l) => UNRESOLVED.test(l));
  assert.equal(notices.length, 1, `expected one notice, got:\n${stderr}`);
  assert.match(notices[0], /CURSOR_PROJECT_DIR/);
});

test('AC4 resolveOwning with no root keys and an empty env returns root null, never the process cwd', () => {
  const abs = join(process.cwd(), 'src', 'frozen.js');
  assert.deepEqual(resolveOwning(noRootPayload(abs), abs, undefined, {}), { root: null, absFile: abs });
  const rel = resolveOwning(noRootPayload('src/frozen.js'), 'src/frozen.js', undefined, {});
  assert.equal(rel.root, null);
  assert.equal(rel.absFile, undefined, 'a relative path with no base must not be resolved against cwd');
  assert.equal(resolveRoot(noRootPayload(abs), abs, undefined, {}), null);
  assert.deepEqual(resolveOwning({}, undefined, undefined, {}), { root: null, absFile: undefined });
});

test('AC4 resolveOwning falls back to a normalized CURSOR_PROJECT_DIR', (t) => {
  const repo = railedRepo(t);
  const env = { CURSOR_PROJECT_DIR: `  ${repo}/  ` };
  const owned = resolveOwning(noRootPayload('src/frozen.js'), 'src/frozen.js', undefined, env);
  assert.deepEqual(owned, { root: repo, absFile: join(repo, 'src', 'frozen.js') });
  assert.equal(resolveRoot({}, undefined, undefined, env), repo);
});

test('AC4 a relative CURSOR_PROJECT_DIR does not resolve (it would be read against cwd)', () => {
  assert.equal(resolveRoot({}, undefined, undefined, { CURSOR_PROJECT_DIR: 'not/absolute/dir' }), null);
  assert.equal(resolveRoot({}, undefined, undefined, { CURSOR_PROJECT_DIR: '.' }), null, 'an existing relative dir is still relative');
});

test('AC4 payload roots take precedence over CURSOR_PROJECT_DIR, and an explicit fallback is honored', (t) => {
  const repo = railedRepo(t);
  const other = realpathSync(tmp(t, 'adlc-cursor-noroot-other-'));
  assert.equal(resolveRoot({ workspace_roots: [repo] }, undefined, undefined, { CURSOR_PROJECT_DIR: other }), repo);
  assert.equal(resolveRoot({}, undefined, other, { CURSOR_PROJECT_DIR: repo }), other);
});

test('decide: enforcement on, no root anywhere → unresolved deny; read-only tools still allowed', (t) => {
  const repo = railedRepo(t);
  const env = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };
  const v = decide(noRootPayload(join(repo, 'src', 'frozen.js')), { env });
  assert.equal(v.permission, 'deny');
  assert.match(v.user_message, UNRESOLVED);
  const read = { tool_name: 'Read', tool_input: { file_path: join(repo, 'src', 'frozen.js') } };
  assert.deepEqual(decide(read, { env }), { permission: 'allow' });
});

test('decide: an opaque path-less mutator with no root and enforcement on is denied as unresolved', () => {
  const v = decide({ tool_name: 'apply_patch', tool_input: { patch: 'not a recognised envelope' } },
    { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' } });
  assert.equal(v.permission, 'deny');
  assert.match(v.user_message, UNRESOLVED);
});

test('decide: an opaque path-less mutator resolves CURSOR_PROJECT_DIR and denies against its active ticket', (t) => {
  const repo = railedRepo(t);
  const v = decide({ tool_name: 'apply_patch', tool_input: { patch: 'opaque' } },
    { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', CURSOR_PROJECT_DIR: repo } });
  assert.equal(v.permission, 'deny');
  assert.doesNotMatch(v.user_message, UNRESOLVED);
  assert.match(v.user_message, /no verifiable target path/);
});

test('decide: an opaque path-less mutator with no root and enforcement OFF is allowed', () => {
  const v = decide({ tool_name: 'apply_patch', tool_input: { patch: 'opaque' } }, { env: {} });
  assert.deepEqual(v, { permission: 'allow' });
});

test('decide: a shell tool with no path and no root is allowed even under enforcement', () => {
  const v = decide({ tool_name: 'Shell', tool_input: { command: 'npm test' } },
    { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' } });
  assert.deepEqual(v, { permission: 'allow' });
});

test('dispatch: buildgate on, P4 off, no root, mutating tool → buildgate denies instead of evaluating cwd', async () => {
  const v = await dispatch({ tool_name: 'Write', tool_input: { file_path: '/nowhere/x.js' } },
    { env: { ADLC_BUILD_GATE_ENFORCEMENT: '1' } });
  assert.equal(v.permission, 'deny');
  assert.match(v.user_message, /build-gate/);
  assert.match(v.user_message, UNRESOLVED);
});

test('dispatch: buildgate on, P4 off, no root, Task spawn → not denied by the buildgate', (t) => {
  const task = JSON.parse(readFileSync(join(HERE, 'fixtures', 'pretool-task-prosecutor.json'), 'utf8'));
  const { verdict } = runPretool(t, task, hookEnv(t, { ADLC_BUILD_GATE_ENFORCEMENT: '1' }));
  assert.doesNotMatch(verdict.user_message ?? '', /build-gate/);
});

test('dispatch: buildgate on, P4 off, no root, shell tool → allowed', async () => {
  const v = await dispatch({ tool_name: 'run_terminal_cmd', tool_input: { command: 'npm test' } },
    { env: { ADLC_BUILD_GATE_ENFORCEMENT: '1' } });
  assert.deepEqual(v, { permission: 'allow' });
});

test('dispatch: buildgate on, no root, read-only tool → allowed', async () => {
  const v = await dispatch({ tool_name: 'Read', tool_input: { file_path: '/nowhere/x.js' } },
    { env: { ADLC_BUILD_GATE_ENFORCEMENT: '1' } });
  assert.deepEqual(v, { permission: 'allow' });
});

test('audit/flailCheck: no root anywhere → observe nothing and write nothing under cwd', async (t) => {
  const repo = railedRepo(t);
  const payload = { file_path: join(repo, 'src', 'frozen.js') };
  assert.deepEqual(audit(payload, { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' } }), { rail: false });
  const r = await flailCheck(payload, { env: {}, importModule: () => { throw new Error('must not load'); } });
  assert.deepEqual(r, { flagged: false, skipped: true });
  assert.equal(existsSync(join(repo, '.adlc', RECENT_EDITS_FILE)), false);
});

test('audit: CURSOR_PROJECT_DIR resolves the root and reports a rail touch', (t) => {
  const repo = railedRepo(t);
  const v = audit({ file_path: join(repo, 'src', 'frozen.js') },
    { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', CURSOR_PROJECT_DIR: repo } });
  assert.equal(v.rail, true);
});

test('unresolved deny names the tool, and "unknown" when the payload names none', () => {
  const env = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };
  const named = decide({ tool_name: 'Write', tool_input: { file_path: '/nowhere/x.js' } }, { env });
  assert.match(named.user_message, /blocked "Write"/);
  const anon = decide({ tool_input: { file_path: '/nowhere/x.js' } }, { env });
  assert.equal(anon.permission, 'deny');
  assert.match(anon.user_message, /blocked "unknown"/);
});

test('dispatch: buildgate consults the root that OWNS the edited path in a multi-root workspace', async (t) => {
  const plain = realpathSync(tmp(t, 'adlc-cursor-noroot-plain-'));
  const owner = realpathSync(tmp(t, 'adlc-cursor-noroot-bg-'));
  const stateDir = realpathSync(tmp(t, 'adlc-cursor-noroot-bgstate-'));
  mkdirSync(join(owner, '.adlc'), { recursive: true });
  writeFileSync(join(owner, '.adlc', 'tickets.json'), JSON.stringify({
    tickets: [{ id: 'T9', title: 'hot', risk: 'high', rails: ['src/frozen.js'] }],
  }));
  writeFileSync(join(stateDir, `cursor-buildgate-depth-${sessionSafeId('bg-sess')}.json`),
    JSON.stringify({ count: DEFAULT_DEPTH_THRESHOLD + 5, updatedAt: Date.now(), sessionId: 'bg-sess' }));
  const payload = {
    tool_name: 'Write',
    tool_input: { file_path: join(owner, 'src', 'free.js') },
    workspace_roots: [plain, owner],
    session_id: 'bg-sess',
  };
  const v = await dispatch(payload, {
    env: { ADLC_TICKET: 'T9', ADLC_BUILD_GATE_ENFORCEMENT: '1', ADLC_CURSOR_STATE_DIR: stateDir },
  });
  assert.equal(v.permission, 'deny', 'the owning root (second declared) is the one gated');
  assert.match(v.user_message, /build-gate/);
});

test('a no-root Task payload reaches the P5 policy once CURSOR_PROJECT_DIR names a repo with no active build', (t) => {
  const repo = railedRepo(t);
  const task = JSON.parse(readFileSync(join(HERE, 'fixtures', 'pretool-task-prosecutor.json'), 'utf8'));
  const { verdict, stderr } = runPretool(t, task,
    hookEnv(t, { ADLC_P4_ENFORCEMENT: '1', CURSOR_PROJECT_DIR: repo }));
  assert.doesNotMatch(verdict.user_message ?? '', UNRESOLVED);
  assert.doesNotMatch(stderr, UNRESOLVED);
});

test('a RELATIVE payload root is not read against the plugin cwd: enforcement denies as unresolved', (t) => {
  const repo = railedRepo(t);
  const payload = { ...noRootPayload(join(repo, 'src', 'frozen.js')), cwd: '.' };
  const { verdict } = runPretool(t, payload, hookEnv(t, { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' }));
  assert.equal(verdict.permission, 'deny');
  assert.match(verdict.user_message, UNRESOLVED);
});

test('candidateRoots normalizes roots and drops relative or blank ones', (t) => {
  const repo = railedRepo(t);
  assert.deepEqual(candidateRoots({ workspace_roots: ['.', '  ', `${repo}/`, 'rel/dir'], cwd: repo }), [repo, repo]);
  assert.deepEqual(candidateRoots({ cwd: '.' }), []);
});

test('CURSOR_PROJECT_DIR naming a DIFFERENT repo leaves an absolute target unresolved (enforcement denies)', (t) => {
  const repo = railedRepo(t);
  const other = realpathSync(tmp(t, 'adlc-cursor-noroot-elsewhere-'));
  const env = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', CURSOR_PROJECT_DIR: other };
  const target = join(repo, 'src', 'frozen.js');
  assert.deepEqual(resolveOwning(noRootPayload(target), target, undefined, env), { root: null, absFile: target });
  const v = decide(noRootPayload(target), { env });
  assert.equal(v.permission, 'deny');
  assert.match(v.user_message, UNRESOLVED);
  const trust = decide(noRootPayload(join(repo, '.adlc', 'tickets.json')), { env });
  assert.equal(trust.permission, 'deny');
});

test('an explicit fallback is honored even for a target outside it (caller-asserted root)', (t) => {
  const repo = railedRepo(t);
  const other = realpathSync(tmp(t, 'adlc-cursor-noroot-fb-'));
  const target = join(repo, 'src', 'frozen.js');
  assert.equal(resolveRoot(noRootPayload(target), target, other, {}), other);
});

test('audit: an unresolvable path in a batch does not hide a later rail touch', (t) => {
  const repo = railedRepo(t);
  const outside = join(realpathSync(tmp(t, 'adlc-cursor-noroot-out-')), 'x.js');
  const payload = { edits: [{ file_path: outside }, { file_path: join(repo, 'src', 'frozen.js') }] };
  const v = audit(payload, { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', CURSOR_PROJECT_DIR: repo } });
  assert.equal(v.rail, true);
});

test('dispatch: buildgate on, a resolvable first target does not hide a later UNRESOLVED target', async (t) => {
  const repo = railedRepo(t);
  const outside = join(realpathSync(tmp(t, 'adlc-cursor-noroot-bgout-')), 'x.js');
  const env = { ADLC_BUILD_GATE_ENFORCEMENT: '1', CURSOR_PROJECT_DIR: repo };
  for (const order of [[join(repo, 'src', 'free.js'), outside], [outside, join(repo, 'src', 'free.js')]]) {
    const v = await dispatch({ tool_name: 'MultiEdit', tool_input: { edits: order.map((file_path) => ({ file_path })) } }, { env });
    assert.equal(v.permission, 'deny', `order ${order.join(', ')}`);
    assert.match(v.user_message, /build-gate/);
    assert.match(v.user_message, UNRESOLVED);
  }
});

test('a shell command that NAMES a file is checked like an edit: no root + enforcement → unresolved deny', () => {
  const env = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };
  const patch = { tool_name: 'run_terminal_cmd', tool_input: { command: "apply_patch <<'P'\n*** Update File: /nowhere/src/frozen.js\nP" } };
  const v = decide(patch, { env });
  assert.equal(v.permission, 'deny');
  assert.match(v.user_message, UNRESOLVED);
  assert.deepEqual(decide({ tool_name: 'run_terminal_cmd', tool_input: { command: 'npm test' } }, { env }), { permission: 'allow' });
});

test('workspace_roots naming repoA leaves an absolute target in repoB unresolved (#1234)', (t) => {
  const repoA = railedRepo(t);
  const repoB = railedRepo(t);
  const outsideTarget = join(repoB, 'src', 'frozen.js');
  const payload = {
    tool_name: 'Write',
    tool_input: { file_path: outsideTarget },
    workspace_roots: [repoA],
  };

  assert.deepEqual(resolveOwning(payload, outsideTarget, undefined, {}), {
    root: null,
    absFile: outsideTarget,
  });

  // Enforcement mode: denies as unresolved rather than evaluating against repoA.
  const enforced = decide(payload, { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' } });
  assert.equal(enforced.permission, 'deny');
  assert.match(enforced.user_message, UNRESOLVED);

  // Advisory mode: emits the unresolved stderr notice rather than silently claiming repoA.
  const { verdict: advisory, stderr } = runPretool(t, payload, hookEnv(t, { ADLC_TICKET: 'T1' }));
  assert.deepEqual(advisory, { permission: 'allow' });
  assert.match(stderr, UNRESOLVED);
});

test('multi-root workspace_roots leaves a target outside ALL declared roots unresolved while honoring inside roots (#1234)', async (t) => {
  const repoA = railedRepo(t);
  const repoB = railedRepo(t);
  const repoC = railedRepo(t);
  const inA = join(repoA, 'src', 'free.js');
  const inB = join(repoB, 'src', 'free.js');
  const inC = join(repoC, 'src', 'frozen.js');

  const multiPayload = (filePath) => ({
    tool_name: 'Write',
    tool_input: { file_path: filePath },
    workspace_roots: [repoA, repoB],
  });

  assert.deepEqual(resolveOwning(multiPayload(inA), inA, undefined, {}), { root: repoA, absFile: inA });
  assert.deepEqual(resolveOwning(multiPayload(inB), inB, undefined, {}), { root: repoB, absFile: inB });
  assert.deepEqual(resolveOwning(multiPayload(inC), inC, undefined, {}), { root: null, absFile: inC });

  const enforced = decide(multiPayload(inC), { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' } });
  assert.equal(enforced.permission, 'deny');
  assert.match(enforced.user_message, UNRESOLVED);

  // A MultiEdit mixing an inside-root target and an outside-root target denies as unresolved in both orders.
  for (const order of [[inA, inC], [inC, inA]]) {
    const batch = {
      tool_name: 'MultiEdit',
      tool_input: { edits: order.map((file_path) => ({ file_path })) },
      workspace_roots: [repoA, repoB],
    };
    const d = decide(batch, { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' } });
    assert.equal(d.permission, 'deny');
    assert.match(d.user_message, UNRESOLVED);

    const bg = await dispatch(batch, { env: { ADLC_BUILD_GATE_ENFORCEMENT: '1' } });
    assert.equal(bg.permission, 'deny');
    assert.match(bg.user_message, /build-gate/);
    assert.match(bg.user_message, UNRESOLVED);
  }
});
