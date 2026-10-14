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
import { decide, resolveOwning, resolveRoot } from '../hooks/adlc-rails-guard.mjs';
import { dispatch } from '../hooks/adlc-pretool.mjs';
import { audit, flailCheck } from '../hooks/adlc-audit.mjs';
import { spawnHook } from './helpers/run-hook.mjs';
import { RECENT_EDITS_FILE } from '../constants.mjs';

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
