// fleet-ext item 15 (`--worker-deps`): the caller-built dependency tree is COPIED
// into the worker worktree before EVERY strike (a plain copy, never an npm run)
// and the configured `init` never runs — the worker starts with node_modules
// populated and has no install path of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, readlinkSync, lstatSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLiveDeps, defaultIo } from '../lib/live-deps.mjs';
import { findInner } from './helpers/worker-calls.mjs';

const ticket = { id: 'T1', title: 'T1', scope: ['packages/x/**'], body: 'do', edges: [] };
function fakeIo(rec) {
  return {
    git: () => (...args) => (args[0] === 'rev-parse' ? 'SHA' : ''),
    adlc: () => ({ status: 0, stdout: '' }), adlcAsync: async () => ({ status: 0, stdout: '' }),
    spawnWorker: async (cmd, args, opts) => { (rec.order ??= []).push('spawn'); rec.spawn.push({ cmd, args, opts }); return { status: 0, stdout: 'TICKET-DONE', stderr: '' }; },
    readFile: () => '', exists: () => false, mkdirp: () => {}, writeJson: () => {}, appendLog: () => {}, ensureGitignore: () => {},
    copyTree: (src, dest) => { (rec.order ??= []).push('copy'); rec.copies.push({ src, dest }); },
    env: { PATH: '/usr/bin', HOME: '/h' }, hasGh: () => false,
  };
}
const sandboxSpec = { mode: 'sandbox', backend: { name: 'bubblewrap' } };
const newRec = () => ({ spawn: [], copies: [] });

test('with --worker-deps the tree is copied into <worktree>/node_modules BEFORE the worker spawn, on every strike', async () => {
  const rec = newRec();
  const deps = buildLiveDeps({ repo: '/repo', config: { gate: { test: 't' }, init: 'npm ci', workerDeps: '/run/worker-deps/node_modules', timeoutMinutes: 1 }, sandboxSpec, io: fakeIo(rec) });
  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 2, deadEnds: ['x'] });
  assert.deepEqual(rec.copies, [
    { src: '/run/worker-deps/node_modules', dest: '/wt/T1/node_modules' },
    { src: '/run/worker-deps/node_modules', dest: '/wt/T1/node_modules' },
  ]);
  // Ordering is the guarantee: every dependency copy lands BEFORE the worker is spawned.
  assert.ok(rec.order.includes('spawn') && rec.order.every((ev, i) => ev !== 'spawn' || rec.order[i - 1] === 'copy'), `a copy immediately precedes EVERY spawn: ${rec.order.join(',')}`);
  assert.equal(rec.spawn.filter((c) => findInner([c], 'claude')).length, 2);
  // No npm ever runs against the worker worktree.
  assert.ok(!rec.spawn.some((c) => [c.cmd, ...c.args].some((a) => /npm/.test(String(a)))), 'no npm spawn at all');
});

test('with --worker-deps the configured init is SKIPPED at worktree creation; without it, init still runs (default unchanged)', async () => {
  const rec = newRec();
  const io = fakeIo(rec);
  io.git = () => (...args) => (args[0] === 'rev-parse' ? 'SHA' : '');
  const withDeps = buildLiveDeps({ repo: '/repo', config: { gate: { test: 't' }, init: 'npm ci --ignore-scripts', workerDeps: '/w' }, sandboxSpec, io });
  await withDeps.createWorktree({ ticket, integrationBranch: 'fleet/run-1' });
  assert.equal(rec.spawn.length, 0, 'no init spawn with --worker-deps');
  const rec2 = newRec();
  const without = buildLiveDeps({ repo: '/repo', config: { gate: { test: 't' }, init: 'npm ci --ignore-scripts' }, sandboxSpec, io: fakeIo(rec2) });
  await without.createWorktree({ ticket, integrationBranch: 'fleet/run-1' });
  const init = rec2.spawn.find((c) => c.args.join(' ').includes('npm ci --ignore-scripts'));
  assert.ok(init, 'init runs (through the sandbox) when no worker-deps is given');
});

test('a copy failure fails the strike cleanly (exit 1, no worker spawn) rather than dispatching without dependencies', async () => {
  const rec = newRec();
  const io = fakeIo(rec);
  io.copyTree = () => { throw new Error('ENOENT: source missing'); };
  const deps = buildLiveDeps({ repo: '/repo', config: { gate: { test: 't' }, workerDeps: '/missing', timeoutMinutes: 1 }, sandboxSpec, io });
  const r = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'S', strike: 1, deadEnds: [] });
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /worker-deps copy failed/);
  assert.equal(rec.spawn.length, 0);
});

test('the real copyTree is a plain file copy that keeps workspace symlinks RELATIVE (they resolve inside the destination)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-workerdeps-'));
  try {
    const src = join(root, 'src', 'node_modules');
    mkdirSync(join(src, '@adlc'), { recursive: true });
    mkdirSync(join(root, 'src', 'packages', 'core'), { recursive: true });
    writeFileSync(join(root, 'src', 'packages', 'core', 'index.mjs'), 'export const x = 1;');
    writeFileSync(join(src, 'left-pad.js'), 'module.exports = 1;');
    symlinkSync('../../packages/core', join(src, '@adlc', 'core'));
    const destWt = join(root, 'wt');
    mkdirSync(join(destWt, 'packages', 'core'), { recursive: true });
    writeFileSync(join(destWt, 'packages', 'core', 'index.mjs'), 'export const x = 2;');
    mkdirSync(join(destWt, 'node_modules', 'stale'), { recursive: true });
    defaultIo().copyTree(src, join(destWt, 'node_modules'));
    assert.equal(readFileSync(join(destWt, 'node_modules', 'left-pad.js'), 'utf8'), 'module.exports = 1;');
    assert.ok(!existsSync(join(destWt, 'node_modules', 'stale')), 'a pre-existing tree is replaced, never merged');
    const link = join(destWt, 'node_modules', '@adlc', 'core');
    assert.ok(lstatSync(link).isSymbolicLink(), 'the workspace link is copied as a link');
    assert.equal(readlinkSync(link), '../../packages/core', 'verbatim (relative) target');
    assert.equal(readFileSync(join(link, 'index.mjs'), 'utf8'), 'export const x = 2;', 'so it resolves inside the DESTINATION worktree');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
