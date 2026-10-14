// #759 / #760: p4's p4-build and flail-check markers are bound to the current
// tree, and p2 is ticket-scoped with the same coldstart integrity as p0.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertPhase, requiresTicket } from '../lib/assertions.mjs';
import { sha256 } from '@adlc/core';
import { tmp, gitRepo } from '@adlc/core/test-kit';
import { appendManifestEntry as realAppendManifestEntry } from '@adlc/gate-manifest';
import { ticketHash as domainTicketHash } from '@adlc/tickets';

const appendManifestEntry = (entry, dir) => realAppendManifestEntry(entry, dir, { key: null });
const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);
const adlcBin = new URL('../bin/adlc.mjs', import.meta.url).pathname;

const SRC = 'src.mjs';
const RAIL = 'test/a.test.mjs';

function write(entries, dir) {
  for (const entry of entries) appendManifestEntry(entry, dir);
}

function p4Fixture(t) {
  const cwd = tmp(t, 'adlc-runner-binding-');
  const dir = join(cwd, '.adlc');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, RAIL), 'test("rail", () => {});\n');
  writeFileSync(join(cwd, SRC), 'export const x = 1;\n');
  return { cwd, dir };
}

function build(ticket, cwdFiles) {
  return { gate: 'p4-build', ticket, files: cwdFiles };
}

function railCheck(ticket) {
  return {
    type: 'rails-check',
    ticket,
    railsDiffEmpty: true,
    suppressionsClean: true,
    railFiles: { [RAIL]: sha256('test("rail", () => {});\n') },
  };
}

function freshP4(dir, ticket = 'T1') {
  write([
    build(ticket, { [SRC]: sha256('export const x = 1;\n') }),
    { type: 'flail-check', ticket },
    railCheck(ticket),
  ], dir);
}

describe('p4 evidence is bound to the current tree (#759)', () => {
  it('passes when the build record hashes match the worktree', (t) => {
    const { cwd, dir } = p4Fixture(t);
    freshP4(dir);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, true);
  });

  it('rejects, as a gate failure, when a file changes after p4-build was recorded', (t) => {
    const { cwd, dir } = p4Fixture(t);
    freshP4(dir);
    writeFileSync(join(cwd, SRC), 'export const x = 2;\n');
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.equal(result.operational, false);
    assert.ok(result.errors.some((e) => e.includes('p4-build') && e.includes('stale') && e.includes(SRC)), result.errors.join('|'));
  });

  it('rejects when a hashed file no longer exists', (t) => {
    const { cwd, dir } = p4Fixture(t);
    write([build('T1', { 'gone.mjs': sha256('x') }), { type: 'flail-check', ticket: 'T1' }, railCheck('T1')], dir);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.equal(result.operational, false);
    assert.ok(result.errors.some((e) => e.includes('p4-build') && e.includes('gone.mjs')));
  });

  it('rejects a p4-build that binds no files', (t) => {
    const { cwd, dir } = p4Fixture(t);
    write([build('T1', {}), { type: 'flail-check', ticket: 'T1' }, railCheck('T1')], dir);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.equal(result.operational, false);
    assert.ok(result.errors.some((e) => e.includes('p4-build') && e.includes('incomplete')));
  });

  for (const [label, files] of [['an array', [SRC]], ['a string', SRC], ['absent', undefined], ['null', null]]) {
    it(`rejects a p4-build whose files field is ${label}`, (t) => {
      const { cwd, dir } = p4Fixture(t);
      write([build('T1', files), { type: 'flail-check', ticket: 'T1' }, railCheck('T1')], dir);
      const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
      assert.equal(result.ok, false);
      assert.equal(result.operational, false);
      assert.ok(result.errors.some((e) => e.includes('binds no files')), result.errors.join('|'));
    });
  }

  it('does not apply the coldstart check to p4 (a contradictory coldstart record is p0/p2 evidence only)', (t) => {
    const { cwd, dir } = p4Fixture(t);
    write([coldstart('T1', [{ what: 'a', why_blocking: 'b' }], 'stale-hash')], dir);
    freshP4(dir);
    assert.equal(assertPhase('p4', { dir, ticket: 'T1', cwd }).ok, true);
  });

  it('rejects a p4-build whose recorded hash is null (file was unreadable when recorded)', (t) => {
    const { cwd, dir } = p4Fixture(t);
    write([build('T1', { [SRC]: null }), { type: 'flail-check', ticket: 'T1' }, railCheck('T1')], dir);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('p4-build') && e.includes(SRC)));
  });

  it('accepts flail-check recorded before p4-build (the documented harness order)', (t) => {
    const { cwd, dir } = p4Fixture(t);
    write([
      { type: 'flail-check', ticket: 'T1' },
      build('T1', { [SRC]: sha256('export const x = 1;\n') }),
      railCheck('T1'),
    ], dir);
    assert.equal(assertPhase('p4', { dir, ticket: 'T1', cwd }).ok, true);
  });

  it('a re-recorded p4-build heals the stale rejection', (t) => {
    const { cwd, dir } = p4Fixture(t);
    freshP4(dir);
    writeFileSync(join(cwd, SRC), 'export const x = 2;\n');
    write([
      build('T1', { [SRC]: sha256('export const x = 2;\n') }),
      { type: 'flail-check', ticket: 'T1' },
    ], dir);
    assert.equal(assertPhase('p4', { dir, ticket: 'T1', cwd }).ok, true);
  });

  it("another ticket's p4-build does not stand in for this ticket's", (t) => {
    const { cwd, dir } = p4Fixture(t);
    write([
      build('T9', { [SRC]: sha256('export const x = 1;\n') }),
      { type: 'flail-check', ticket: 'T1' },
      railCheck('T1'),
    ], dir);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['p4-build']);
  });

  it('keeps reporting a missing marker as missing evidence, not as a binding error', (t) => {
    const { cwd, dir } = p4Fixture(t);
    write([build('T1', { [SRC]: sha256('export const x = 1;\n') }), railCheck('T1')], dir);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['flail-check']);
  });
});

function ticketDef(id) {
  return { id, title: `${id} fixture`, scope: ['src/**'], rails: [], edges: [] };
}

function p2Fixture(t, id = 'T1') {
  const dir = tmp(t, 'adlc-runner-p2-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [ticketDef(id), ticketDef('T9')] }));
  return { dir, hash: domainTicketHash(ticketDef(id)) };
}

const coldstart = (ticket, gaps, ticketHash) => ({
  gate: 'coldstart',
  ticket,
  data: { verdict: JSON.stringify({ gaps, ticketHash }) },
});

describe('p2 is ticket-scoped and validates coldstart like p0 (#760)', () => {
  it('requires --ticket (fail closed, operational)', (t) => {
    const { dir } = p2Fixture(t);
    assert.equal(requiresTicket('p2'), true);
    const result = assertPhase('p2', { dir });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((e) => e.includes('p2 requires --ticket')));
  });

  it('passes with a clean, current coldstart and a merge-forecast for the same ticket', (t) => {
    const { dir, hash } = p2Fixture(t);
    write([coldstart('T1', [], hash), { gate: 'merge-forecast', ticket: 'T1' }], dir);
    assert.equal(assertPhase('p2', { dir, ticket: 'T1' }).ok, true);
  });

  it('rejects, as a gate failure, a coldstart that p0 rejects (unresolved gaps)', (t) => {
    const { dir, hash } = p2Fixture(t);
    write([
      coldstart('T1', [{ what: 'a', why_blocking: 'b' }, { what: 'c', why_blocking: 'd' }, { what: 'e', why_blocking: 'f' }], hash),
      { gate: 'merge-forecast', ticket: 'T1' },
    ], dir);
    const p0 = assertPhase('p0', { dir, ticket: 'T1' });
    const p2 = assertPhase('p2', { dir, ticket: 'T1' });
    assert.equal(p0.ok, false);
    assert.equal(p2.ok, false);
    assert.equal(p2.operational, false);
    assert.ok(p2.errors.some((e) => e.includes('3 unresolved gap')), p2.errors.join('|'));
    assert.ok(p2.errors.every((e) => e.startsWith('P2 evidence')), 'errors name the p2 phase');
  });

  it('rejects a coldstart recorded against a stale ticket definition', (t) => {
    const { dir } = p2Fixture(t);
    write([coldstart('T1', [], 'stale-hash'), { gate: 'merge-forecast', ticket: 'T1' }], dir);
    const result = assertPhase('p2', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('stale')));
  });

  it("another ticket's merge-forecast does not satisfy p2", (t) => {
    const { dir, hash } = p2Fixture(t);
    write([coldstart('T1', [], hash), { gate: 'merge-forecast', ticket: 'T9' }], dir);
    const result = assertPhase('p2', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['merge-forecast']);
  });

  it("another ticket's clean coldstart does not satisfy p2", (t) => {
    const { dir, hash } = p2Fixture(t);
    write([coldstart('T9', [], hash), { gate: 'merge-forecast', ticket: 'T1' }], dir);
    const result = assertPhase('p2', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['coldstart']);
  });
});

describe('real adlc bin (#759, #760)', () => {
  it('adlc run p2: no ticket is exit 1; a p0-rejected coldstart is exit 2', (t) => {
    const cwd = tmp(t, 'adlc-runner-p2-bin-');
    const dir = join(cwd, '.adlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [ticketDef('T1'), ticketDef('T9')] }));
    write([
      coldstart('T1', [{ what: 'a', why_blocking: 'b' }], domainTicketHash(ticketDef('T1'))),
      { gate: 'merge-forecast', ticket: 'T9' },
    ], dir);
    const noTicket = spawnSync(process.execPath, [adlcBin, 'run', 'p2'], { cwd, encoding: 'utf8' });
    assert.equal(noTicket.status, 1, noTicket.stdout + noTicket.stderr);
    assert.match(noTicket.stderr, /p2 requires --ticket/);
    const rejected = spawnSync(process.execPath, [adlcBin, 'run', 'p2', '--ticket', 'T1'], { cwd, encoding: 'utf8' });
    assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr);
    assert.match(rejected.stderr, /unresolved gap/);
  });

  it('adlc run p4: a source edit after the build record flips exit 0 to exit 2 naming p4-build', (t) => {
    const { dir: cwd, g } = gitRepo(t);
    const adlcDir = join(cwd, '.adlc');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, RAIL), 'test("rail", () => {});\n');
    writeFileSync(join(cwd, SRC), 'export const x = 1;\n');
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
    const buildRec = run('packages/gate-manifest/bin/gate-manifest.mjs', ['record', 'p4-build', '--ticket', 'T1', '--files', SRC]);
    assert.equal(buildRec.status, 0, buildRec.stderr);
    writeFileSync(join(cwd, 'session.log'), 'Build started\nDone in 2.3s\nAll tests passed.\n');
    const flail = run('packages/flail-detector/bin/flail-detector.mjs', [join(cwd, 'session.log'), '--record', '--ticket', 'T1']);
    assert.equal(flail.status, 0, flail.stderr);

    const ok = spawnSync(process.execPath, [adlcBin, 'run', 'p4', '--ticket', 'T1'], { cwd, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);

    writeFileSync(join(cwd, SRC), 'export const x = 3;\n');
    const stale = spawnSync(process.execPath, [adlcBin, 'run', 'p4', '--ticket', 'T1'], { cwd, encoding: 'utf8' });
    assert.equal(stale.status, 2, stale.stdout + stale.stderr);
    assert.match(stale.stderr, /stale: file changed after p4-build was recorded: src\.mjs/);
  });
});
