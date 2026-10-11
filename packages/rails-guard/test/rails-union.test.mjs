// #1050 — the local gate checks the UNION of every active ticket's rails.
//
// `rails-guard --ticket <id>` used to load rails from that one ticket, so an edit to
// ANOTHER active ticket's frozen rail passed P3 clean and surfaced later, at
// tier-check, wearing the wrong label (a tiering demand, not a rail violation). The
// CI gate (lib/ci/rail-freeze.mjs) and tier.mjs already take the union; this file pins
// the local bin to the same rule and proves the two verdicts cannot drift apart.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRailSet } from '../lib/rails.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'rails-guard.mjs');
const CI_BIN = join(HERE, '..', 'bin', 'rails-guard-ci.mjs');

// Every fixture the factories below mint; removed once this file's tests finish.
const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

// ---- fixtures ---------------------------------------------------------------------

const MINE = 'T-MINE';
const OTHER = 'T-OTHER';
const DONE = 'T-DONE';

const TICKETS = [
  { id: MINE, title: 'the ticket being built', scope: ['mine/**'], rails: ['mine/frozen/**'] },
  { id: OTHER, title: 'a sibling build in flight', scope: ['other/**'], rails: ['other/rail.txt'] },
  { id: DONE, title: 'shipped and completed', rails: ['done/**'], completed: true },
];

function writeStore(root, tickets) {
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ schema: 1, tickets }, null, 2) + '\n');
}

/** A repo on `main` with a base commit, then a `feat` branch for the PR's edits. */
function scratchRepo({ tickets = TICKETS } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rails-union-'));
  fixtureDirs.add(root);
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@test.invalid');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'config.json'), JSON.stringify({
    schema: 1,
    securityMode: 'unsigned-fallback',
    acknowledgedNewRailBypass: true,
  }, null, 2) + '\n');
  writeStore(root, tickets);
  for (const file of ['mine/frozen/a.txt', 'mine/src.txt', 'other/rail.txt', 'done/rail.txt', 'src/x.txt']) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), 'baseline\n');
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'feat');
  return { root, g };
}

function editAndCommit({ root, g }, file, message = `edit ${file}`) {
  writeFileSync(join(root, file), 'changed\n');
  g('add', '-A');
  g('commit', '-q', '-m', message);
}

/** Run the LOCAL bin from the fixture root. */
function runBin(root, args) {
  const r = spawnSync(process.execPath, [BIN, '--base', 'main', ...args], { cwd: root, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Run the CI gate's entry point from the fixture root; it spawns the local bin itself. */
function runCi(root) {
  const r = spawnSync(process.execPath, [CI_BIN, '--base', 'main'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, RAILS_BASE: '', BASE_REF: '' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const json = (r) => JSON.parse(r.stdout);

// ---- AC4: the pure resolver --------------------------------------------------------

describe('resolveRailSet', () => {
  test('explicit cli globs win, with no owner, even when tickets declare rails', () => {
    const tickets = [{ id: 'T1', rails: ['test/**'] }];
    const { rails, error } = resolveRailSet({ cliRails: ['src/types/**'], ticket: tickets[0], tickets });
    assert.deepEqual(rails, [{ glob: 'src/types/**', owner: null }]);
    assert.equal(error, null);
  });

  test('without cli globs, the union of every active ticket is tagged with its owner', () => {
    const tickets = [
      { id: 'T1', rails: ['a/**'] },
      { id: 'T2', rails: ['b/**', 'c.txt'] },
      { id: 'T3' },
    ];
    const { rails, error } = resolveRailSet({ cliRails: [], ticket: tickets[0], tickets });
    assert.deepEqual(rails, [
      { glob: 'a/**', owner: 'T1' },
      { glob: 'b/**', owner: 'T2' },
      { glob: 'c.txt', owner: 'T2' },
    ]);
    assert.equal(error, null);
  });

  test('--ticket does not narrow the set: the named ticket is just one member of the union', () => {
    const tickets = [{ id: 'T1', rails: ['a/**'] }, { id: 'T2', rails: ['b/**'] }];
    const named = resolveRailSet({ cliRails: [], ticket: tickets[1], tickets });
    const unnamed = resolveRailSet({ cliRails: [], ticket: null, tickets });
    assert.deepEqual(named.rails, unnamed.rails);
    assert.equal(named.rails.length, 2);
  });

  test('a completed ticket is excluded only on a strict boolean true', () => {
    const tickets = [
      { id: 'T-TRUE', rails: ['x/**'], completed: true },
      { id: 'T-STR', rails: ['y/**'], completed: 'true' },
      { id: 'T-ONE', rails: ['z/**'], completed: 1 },
      { id: 'T-FALSE', rails: ['w/**'], completed: false },
    ];
    const { rails } = resolveRailSet({ cliRails: [], ticket: null, tickets });
    assert.deepEqual(rails.map((r) => r.owner), ['T-STR', 'T-ONE', 'T-FALSE']);
  });

  test('duplicates collapse by (glob, owner); the same glob under two owners is two entries', () => {
    const tickets = [
      { id: 'T1', rails: ['shared/**', 'shared/**'] },
      { id: 'T2', rails: ['shared/**'] },
    ];
    const { rails } = resolveRailSet({ cliRails: [], ticket: null, tickets });
    assert.deepEqual(rails, [
      { glob: 'shared/**', owner: 'T1' },
      { glob: 'shared/**', owner: 'T2' },
    ]);
    const cli = resolveRailSet({ cliRails: ['a/**', 'a/**'], ticket: null, tickets });
    assert.deepEqual(cli.rails, [{ glob: 'a/**', owner: null }]);
  });

  test('an empty union with no cli globs is the operational error', () => {
    const tickets = [{ id: 'T1' }, { id: 'T2', rails: ['x/**'], completed: true }];
    const { rails, error } = resolveRailSet({ cliRails: [], ticket: null, tickets });
    assert.deepEqual(rails, []);
    assert.equal(error, 'no active ticket declares rails and no --rails supplied — nothing to guard');
    const none = resolveRailSet({ cliRails: [], ticket: null, tickets: [] });
    assert.equal(none.error, 'no active ticket declares rails and no --rails supplied — nothing to guard');
  });

  test('inputs are not mutated', () => {
    const tickets = [{ id: 'T1', rails: ['a/**'] }, { id: 'T2', rails: ['b/**'], completed: true }];
    const cliRails = ['c/**'];
    const snapshot = JSON.stringify({ tickets, cliRails });
    resolveRailSet({ cliRails, ticket: tickets[0], tickets });
    resolveRailSet({ cliRails: [], ticket: tickets[0], tickets });
    assert.equal(JSON.stringify({ tickets, cliRails }), snapshot);
  });
});

// ---- AC1–AC3: the bin -------------------------------------------------------------

describe('rails-guard bin — the union of active rails', () => {
  test('AC1: editing ANOTHER active ticket\'s rail with --ticket mine exits 2 and names the owner', () => {
    const repo = scratchRepo();
    editAndCommit(repo, 'other/rail.txt');

    const human = runBin(repo.root, ['--ticket', MINE]);
    assert.equal(human.status, 2, human.stderr);
    assert.match(human.stderr, /other\/rail\.txt/);
    assert.match(human.stderr, /matched globs: other\/rail\.txt/);
    assert.match(human.stderr, new RegExp(`\\(rail of ticket ${OTHER}\\)`));

    const machine = runBin(repo.root, ['--ticket', MINE, '--json']);
    assert.equal(machine.status, 2, machine.stderr);
    const result = json(machine);
    assert.equal(result.ticket, MINE);
    assert.equal(result.passed, false);
    const violation = result.violations.find((v) => v.type === 'rail-edit');
    assert.equal(violation.file, 'other/rail.txt');
    assert.equal(violation.ownerTicket, OTHER);
    assert.deepEqual(result.railSources, [
      { glob: 'mine/frozen/**', owner: MINE },
      { glob: 'other/rail.txt', owner: OTHER },
    ]);
    assert.deepEqual(result.railGlobs, ['mine/frozen/**', 'other/rail.txt']);
  });

  test('AC1: a violation of the NAMED ticket\'s own rail carries ownerTicket but no "(rail of ticket …)" suffix', () => {
    const repo = scratchRepo();
    editAndCommit(repo, 'mine/frozen/a.txt');
    const human = runBin(repo.root, ['--ticket', MINE]);
    assert.equal(human.status, 2);
    assert.match(human.stderr, /mine\/frozen\/a\.txt/);
    assert.doesNotMatch(human.stderr, /rail of ticket/);
    const machine = runBin(repo.root, ['--ticket', MINE, '--json']);
    assert.equal(json(machine).violations[0].ownerTicket, MINE);
  });

  test('AC2: a change only to the named ticket\'s non-rail path exits 0', () => {
    const repo = scratchRepo();
    editAndCommit(repo, 'mine/src.txt');
    const r = runBin(repo.root, ['--ticket', MINE]);
    assert.equal(r.status, 0, r.stderr);
  });

  test('AC2: a completed ticket\'s rails are inert', () => {
    const repo = scratchRepo();
    editAndCommit(repo, 'done/rail.txt');
    const r = runBin(repo.root, ['--ticket', MINE, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const result = json(r);
    assert.ok(result.railSources.every((s) => s.owner !== DONE), 'the completed ticket must not appear in the rail set');
  });

  test('AC3: no --ticket and no --rails is legal and checks the union', () => {
    const repo = scratchRepo();
    editAndCommit(repo, 'other/rail.txt');
    const human = runBin(repo.root, []);
    assert.equal(human.status, 2, human.stderr);
    assert.match(human.stderr, new RegExp(`other/rail\\.txt.*\\(rail of ticket ${OTHER}\\)`));
    const machine = runBin(repo.root, ['--json']);
    assert.equal(json(machine).ticket, null);
    assert.equal(json(machine).violations[0].ownerTicket, OTHER);
  });

  test('AC3: no --ticket, no --rails and a clean diff exits 0', () => {
    const repo = scratchRepo();
    editAndCommit(repo, 'src/x.txt');
    const r = runBin(repo.root, []);
    assert.equal(r.status, 0, r.stderr);
  });

  test('AC3: with no active rails at all the run is the operational error, exit 1', () => {
    const repo = scratchRepo({ tickets: [{ id: DONE, title: 'done', rails: ['done/**'], completed: true }] });
    editAndCommit(repo, 'done/rail.txt');
    const r = runBin(repo.root, []);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no active ticket declares rails and no --rails supplied/);
  });

  test('--ticket naming an unknown id is still an operational error', () => {
    const repo = scratchRepo();
    editAndCommit(repo, 'src/x.txt');
    const r = runBin(repo.root, ['--ticket', 'T-NOPE']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /T-NOPE.*not found/);
  });

  test('explicit --rails still wins over the store and reports no owner', () => {
    const repo = scratchRepo();
    editAndCommit(repo, 'other/rail.txt');
    const r = runBin(repo.root, ['--rails', 'src/**', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(json(r).railSources, [{ glob: 'src/**', owner: null }]);
  });

  test('--ticket still selects whose allow-suppression declarations apply', () => {
    const SKIP = '.sk' + 'ip('; // assembled so this file never carries the marker on an added line
    const tickets = [
      { id: MINE, title: 'mine', body: `allow-suppression: ${SKIP}`, rails: ['mine/frozen/**'] },
      { id: OTHER, title: 'other', body: '', rails: ['other/rail.txt'] },
    ];
    const repo = scratchRepo({ tickets });
    writeFileSync(join(repo.root, 'src/x.txt'), `it${SKIP}'known', () => {});\n`);
    repo.g('add', '-A');
    repo.g('commit', '-q', '-m', 'add a skip');
    assert.equal(runBin(repo.root, ['--ticket', MINE]).status, 0);
    assert.equal(runBin(repo.root, ['--ticket', OTHER]).status, 2);
    assert.equal(runBin(repo.root, []).status, 2, 'no --ticket means no allowances');
  });
});

// ---- AC5: the local verdict and the CI gate agree ------------------------------------

describe('rails-guard bin and the CI rail-freeze gate agree', () => {
  test('AC5: both fail on another active ticket\'s rail, naming the same path', () => {
    const repo = scratchRepo();
    editAndCommit(repo, 'other/rail.txt');
    const local = runBin(repo.root, ['--ticket', MINE]);
    const ci = runCi(repo.root);
    assert.equal(local.status, 2, local.stderr);
    assert.equal(ci.status, 2, ci.stderr);
    assert.match(local.stderr, /\[rail-edit\]\s+other\/rail\.txt/);
    assert.match(ci.stderr, /\[rail-edit\]\s+other\/rail\.txt/);
  });

  test('AC5: both pass when only a completed ticket\'s rail is edited', () => {
    const repo = scratchRepo();
    editAndCommit(repo, 'done/rail.txt');
    const local = runBin(repo.root, ['--ticket', MINE]);
    const ci = runCi(repo.root);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(ci.status, 0, ci.stderr);
  });
});
