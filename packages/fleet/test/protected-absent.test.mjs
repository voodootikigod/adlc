// An absent or unreadable protected control file must fail the integrity stage
// (#632). Before the fix collectProtectedCandidates dropped any candidate whose
// read threw or returned nothing, so a worker that deleted `.adlc/tickets.json`
// (or chmodded it 000) passed the gate with stage 'passed'. parseStatusPaths is
// the production parser of the `git status` listing that feeds the scan; it is
// driven here with the output of a real git, through the same trimming adapter
// the live deps use.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runGatePipeline, collectProtectedCandidates, UNREADABLE_REASON } from '../lib/gate-pipeline.mjs';
import { parseStatusPaths, STATUS_ARGS } from '../lib/live-deps.mjs';
import { defaultGit } from '../lib/worktrees.mjs';
import { Sandbox, SANDBOX_MODES } from '../lib/sandbox.mjs';

const okSandbox = () => new Sandbox({
  mode: SANDBOX_MODES.SANDBOX, backend: { name: 'bubblewrap' }, worktree: '/wt', syntheticHome: '/wt/.home',
  exec: () => 'ok',
});
const ticket = { id: 'T1', scope: ['packages/fleet/**'] };
const TRUST_ROOT = '.adlc/tickets.json';
const TRUST_BYTES = '{"tickets":[{"id":"T1"}]}';
const templates = () => new Map([[TRUST_ROOT, TRUST_BYTES]]);

const gateWith = (listProtected, readBytes) => runGatePipeline(ticket, {
  sandbox: okSandbox(), gate: {}, env: {}, changedPaths: [],
  templates: templates(), listProtected, readBytes,
});

// ── AC1: collectProtectedCandidates keeps unreadable paths ─────────────────

test('a protected path whose read throws becomes an unreadable candidate', () => {
  const cands = collectProtectedCandidates({
    listProtected: () => [TRUST_ROOT],
    readBytes: () => { throw new Error('EACCES'); },
  });
  assert.deepEqual(cands, [{ path: TRUST_ROOT, bytes: null, unreadable: true }]);
});

test('a protected path whose read returns undefined or null becomes an unreadable candidate', () => {
  for (const missing of [undefined, null]) {
    const cands = collectProtectedCandidates({
      listProtected: () => [TRUST_ROOT, '.claude/settings.local.json'],
      readBytes: () => missing,
    });
    assert.deepEqual(cands, [
      { path: TRUST_ROOT, bytes: null, unreadable: true },
      { path: '.claude/settings.local.json', bytes: null, unreadable: true },
    ]);
  }
});

test('a readable protected path is a plain candidate, and an empty file is readable', () => {
  const cands = collectProtectedCandidates({
    listProtected: () => [TRUST_ROOT, '.adlc/config.json'],
    readBytes: (p) => (p === TRUST_ROOT ? TRUST_BYTES : ''),
  });
  assert.deepEqual(cands, [
    { path: TRUST_ROOT, bytes: TRUST_BYTES },
    { path: '.adlc/config.json', bytes: '' },
  ]);
});

test('non-protected and inert paths are still not candidates, even when unreadable', () => {
  const cands = collectProtectedCandidates({
    listProtected: () => ['src/app.js', '.adlc/fleet-logs/T1.log'],
    readBytes: () => undefined,
  });
  assert.deepEqual(cands, []);
});

// ── AC2: runGatePipeline fails the integrity stage ──────────────────────────

test('a deleted protected manifest file fails the protected-paths stage with the absent/unreadable reason', async () => {
  const r = await gateWith(() => [TRUST_ROOT], () => undefined);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'protected-paths');
  assert.equal(r.output, `${TRUST_ROOT}: ${UNREADABLE_REASON}`);
});

test('a deleted non-manifest protected file fails with the absent/unreadable reason, not "unexpected file"', async () => {
  const r = await gateWith(() => ['.adlc/tickets/t-1--abc.json'], () => undefined);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'protected-paths');
  assert.equal(r.output, `.adlc/tickets/t-1--abc.json: ${UNREADABLE_REASON}`);
});

test('an unreadable file is reported alongside a modified one', async () => {
  const r = await gateWith(
    () => ['.claude/settings.local.json', TRUST_ROOT],
    (p) => { if (p === TRUST_ROOT) return 'tampered'; throw new Error('EACCES'); },
  );
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'protected-paths');
  assert.equal(r.output, [
    `.claude/settings.local.json: ${UNREADABLE_REASON}`,
    `${TRUST_ROOT}: worker modified a protected control file`,
  ].join('; '));
});

test('UNREADABLE_REASON says absent or unreadable', () => {
  assert.equal(UNREADABLE_REASON, 'protected control file is absent or unreadable');
});

// ── AC4: regression guard ───────────────────────────────────────────────────

test('a present, byte-identical protected file and inert paths still pass', async () => {
  const r = await gateWith(
    () => [TRUST_ROOT, '.adlc/fleet-logs/T1.log', 'src/app.js'],
    (p) => (p === TRUST_ROOT ? TRUST_BYTES : undefined),
  );
  assert.deepEqual(r, { ok: true, stage: 'passed', output: '' });
});

// ── AC3: parseStatusPaths on real git output ───────────────────────────────

const fixtureDirs = [];
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

function makeRepo() {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'fleet-status-z-'));
  fixtureDirs.push(fixtureDir);
  const root = realpathSync(fixtureDir);
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, '.adlc'));
  writeFileSync(join(root, TRUST_ROOT), TRUST_BYTES);
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, '.gitignore'), '.claude/settings.local.json\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return { root, g };
}

test('STATUS_ARGS is the NUL-delimited porcelain v1 listing with ignored and all untracked files', () => {
  assert.deepEqual(STATUS_ARGS, ['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all']);
});

test('parseStatusPaths returns literal paths from real git -z output: deletion, tab+quote name, rename, ignored', () => {
  const { root, g } = makeRepo();
  rmSync(join(root, TRUST_ROOT)); // " D" record — sorts first, so the adapter's trim eats its leading space
  const odd = '.adlc/we\tird"name.json';
  writeFileSync(join(root, odd), '{}');
  g('mv', 'a.txt', 'b.txt');
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude/settings.local.json'), '{}');

  const out = defaultGit(root)(...STATUS_ARGS); // the production (trimming) adapter
  assert.ok(out.startsWith('D '), `the first record lost its leading space to the adapter's trim: ${JSON.stringify(out)}`);
  const paths = parseStatusPaths(out);
  assert.deepEqual([...paths].sort(), [TRUST_ROOT, '.claude/settings.local.json', odd, 'a.txt', 'b.txt'].sort());
});

test('parseStatusPaths end to end: a deleted trust root in a real repo fails the gate', async () => {
  const { root } = makeRepo();
  rmSync(join(root, TRUST_ROOT));
  const readBytes = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined);
  const r = await gateWith(() => parseStatusPaths(defaultGit(root)(...STATUS_ARGS)), readBytes);
  assert.equal(r.ok, false);
  assert.equal(r.output, `${TRUST_ROOT}: ${UNREADABLE_REASON}`);
});

test('parseStatusPaths parses untrimmed records, both rename forms, and empty input', () => {
  assert.deepEqual(parseStatusPaths(' D .adlc/x.json\0?? .claude/y\0'), ['.adlc/x.json', '.claude/y']);
  assert.deepEqual(parseStatusPaths('M  .adlc/x.json\0'), ['.adlc/x.json']);
  assert.deepEqual(parseStatusPaths('R  new.json\0old.json\0 M z\0'), ['new.json', 'old.json', 'z']);
  assert.deepEqual(parseStatusPaths('C  copy.json\0src.json\0'), ['copy.json', 'src.json']);
  assert.deepEqual(parseStatusPaths(' R .adlc/n\0.adlc/o\0'), ['.adlc/n', '.adlc/o']);
  // The same worktree rename as the first record after the adapter's trim: its
  // XY code is the single letter `R`, and the original path still follows.
  assert.deepEqual(parseStatusPaths('R .adlc/n\0.adlc/o\0?? .claude/z\0'), ['.adlc/n', '.adlc/o', '.claude/z']);
  assert.deepEqual(parseStatusPaths('?? a b.txt\0'), ['a b.txt'], 'spaces inside a path are kept');
  assert.deepEqual(parseStatusPaths(''), []);
  assert.deepEqual(parseStatusPaths(undefined), []);
});
