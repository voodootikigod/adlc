// #759: flail-check is bound to the tree exactly like p4-build — it must carry a
// files map and every hash must still match the worktree. No ordering rule
// between the two markers (the shipped harness prompts record flail-check first).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertPhase } from '../lib/assertions.mjs';
import { sha256 } from '@adlc/core';
import { tmp, gitRepo } from '@adlc/core/test-kit';
import { appendManifestEntry as realAppendManifestEntry } from '@adlc/gate-manifest';

const appendManifestEntry = (entry, dir) => realAppendManifestEntry(entry, dir, { key: null });
const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);
const adlcBin = new URL('../bin/adlc.mjs', import.meta.url).pathname;

const SRC = 'src.mjs';
const RAIL = 'test/a.test.mjs';
const SRC_BODY = 'export const x = 1;\n';
const RAIL_BODY = 'test("rail", () => {});\n';

function fixture(t) {
  const cwd = tmp(t, 'adlc-runner-flail-binding-');
  const dir = join(cwd, '.adlc');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, RAIL), RAIL_BODY);
  writeFileSync(join(cwd, SRC), SRC_BODY);
  return { cwd, dir };
}

const build = (files = { [SRC]: sha256(SRC_BODY) }) => ({ gate: 'p4-build', ticket: 'T1', files });
const flail = (files) => (files === undefined
  ? { type: 'flail-check', ticket: 'T1' }
  : { type: 'flail-check', ticket: 'T1', files });
const railCheck = () => ({
  type: 'rails-check', ticket: 'T1', railsDiffEmpty: true, suppressionsClean: true,
  railFiles: { [RAIL]: sha256(RAIL_BODY) },
});

function record(dir, entries) {
  for (const entry of entries) appendManifestEntry(entry, dir);
}

const fresh = { [SRC]: sha256(SRC_BODY) };

describe('flail-check is bound to the current tree (#759)', () => {
  it('passes when the flail-check hashes match the worktree', (t) => {
    const { cwd, dir } = fixture(t);
    record(dir, [build(), flail(fresh), railCheck()]);
    assert.equal(assertPhase('p4', { dir, ticket: 'T1', cwd }).ok, true);
  });

  it('passes when flail-check is recorded before p4-build (no ordering rule)', (t) => {
    const { cwd, dir } = fixture(t);
    record(dir, [flail(fresh), build(), railCheck()]);
    assert.equal(assertPhase('p4', { dir, ticket: 'T1', cwd }).ok, true);
  });

  it('rejects, as a gate failure, when a file changes after flail-check was recorded', (t) => {
    const { cwd, dir } = fixture(t);
    record(dir, [build(), flail(fresh), railCheck()]);
    writeFileSync(join(cwd, SRC), 'export const x = 2;\n');
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.equal(result.operational, false);
    assert.ok(
      result.errors.some((e) => e.includes('flail-check') && e.includes('stale') && e.includes(SRC)),
      result.errors.join('|'),
    );
  });

  it('rejects a flail-check that binds no files map (fail closed)', (t) => {
    const { cwd, dir } = fixture(t);
    record(dir, [build(), flail(), railCheck()]);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('flail-check') && e.includes('binds no files')), result.errors.join('|'));
  });

  it('rejects a flail-check with an empty files map', (t) => {
    const { cwd, dir } = fixture(t);
    record(dir, [build(), flail({}), railCheck()]);
    assert.equal(assertPhase('p4', { dir, ticket: 'T1', cwd }).ok, false);
  });

  it('rejects a flail-check whose hashed file no longer exists', (t) => {
    const { cwd, dir } = fixture(t);
    record(dir, [build(), flail({ 'gone.mjs': sha256('x') }), railCheck()]);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('flail-check') && e.includes('cannot be read') && e.includes('gone.mjs')), result.errors.join('|'));
  });

  it('rejects a flail-check entry that carries a null hash', (t) => {
    const { cwd, dir } = fixture(t);
    record(dir, [build(), flail({ [SRC]: null }), railCheck()]);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('flail-check') && e.includes('missing hash') && e.includes(SRC)), result.errors.join('|'));
  });

  it('judges only the latest flail-check: a fresh re-record supersedes a stale one', (t) => {
    const { cwd, dir } = fixture(t);
    record(dir, [build(), flail({ [SRC]: sha256('old\n') }), flail(fresh), railCheck()]);
    assert.equal(assertPhase('p4', { dir, ticket: 'T1', cwd }).ok, true);
  });

  it("another ticket's stale flail-check does not reject this ticket", (t) => {
    const { cwd, dir } = fixture(t);
    record(dir, [
      { type: 'flail-check', ticket: 'T9', files: { [SRC]: sha256('other\n') } },
      build(), flail(fresh), railCheck(),
    ]);
    assert.equal(assertPhase('p4', { dir, ticket: 'T1', cwd }).ok, true);
  });

  it('reports a missing flail-check only through the presence check', (t) => {
    const { cwd, dir } = fixture(t);
    record(dir, [build(), railCheck()]);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['flail-check']);
  });

  it('end to end: the real flail-detector and runner bins reject a tree edited after the flail record', (t) => {
    const { dir: cwd, g } = gitRepo(t);
    const adlcDir = join(cwd, '.adlc');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, RAIL), RAIL_BODY);
    writeFileSync(join(cwd, SRC), SRC_BODY);
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'tickets.json'), JSON.stringify({
      tickets: [{ id: 'T1', title: 'T1 fixture', scope: [SRC], rails: ['test/**'], edges: [] }],
    }));
    g('add', '-A');
    g('commit', '-q', '-m', 'initial');
    const base = g('rev-parse', 'HEAD').trim();
    writeFileSync(join(cwd, SRC), 'export const x = 2;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'non-rail change');

    const run = (bin, args) => spawnSync(process.execPath, [join(repoRoot, bin), ...args], { cwd, encoding: 'utf8' });
    const rails = run('packages/rails-guard/bin/rails-guard.mjs', ['--ticket', 'T1', '--tickets', join(adlcDir, 'tickets.json'), '--base', base, '--record']);
    assert.equal(rails.status, 0, rails.stderr);
    writeFileSync(join(cwd, 'session.log'), 'Build started\nDone in 2.3s\nAll tests passed.\n');
    // The harness order: flail-check first, then p4-build.
    const flailRec = run('packages/flail-detector/bin/flail-detector.mjs', [join(cwd, 'session.log'), '--record', '--ticket', 'T1', '--files', SRC]);
    assert.equal(flailRec.status, 0, flailRec.stderr);
    const buildRec = run('packages/gate-manifest/bin/gate-manifest.mjs', ['record', 'p4-build', '--ticket', 'T1', '--files', SRC]);
    assert.equal(buildRec.status, 0, buildRec.stderr);

    const ok = spawnSync(process.execPath, [adlcBin, 'run', 'p4', '--ticket', 'T1'], { cwd, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);

    writeFileSync(join(cwd, SRC), 'export const x = 3;\n');
    // Re-record p4-build only: the stale flail-check alone must fail the gate.
    const rebuild = run('packages/gate-manifest/bin/gate-manifest.mjs', ['record', 'p4-build', '--ticket', 'T1', '--files', SRC]);
    assert.equal(rebuild.status, 0, rebuild.stderr);
    const stale = spawnSync(process.execPath, [adlcBin, 'run', 'p4', '--ticket', 'T1'], { cwd, encoding: 'utf8' });
    assert.equal(stale.status, 2, stale.stdout + stale.stderr);
    assert.match(stale.stderr, /stale: file changed after flail-check was recorded: src\.mjs/);
  });
});
