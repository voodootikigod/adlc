// infer-scope-gate.test.mjs — issues #779 (data loss) and #782 (false green).
//
// #779: scope-existence was the SOLE staleness inference and it was always on.
// It answers "do the ticket's declared scope globs resolve to tracked files on
// the base ref?", which on any repo older than its ticket backlog is true the
// instant a ticket is authored — a ticket scoped to `packages/core/**` matches
// because that directory already exists, not because the ticket's work landed.
// `--write` then archives every rails-less ticket it marked stale and exits 0
// with a success line, so a documented `ticket-prune` → `ticket-prune --write`
// run silently removes the live backlog. These tests pin the inference OFF by
// default and pin that turning it on reproduces the old classification exactly.
//
// #782: the shipped CI recipe guarded its ticket-prune step on the LEGACY flat
// file, so on a sharded store the step forced rc=0 and printed "nothing to
// prune" without running the tool at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTicket, classifyTickets } from '../lib/detect.mjs';
import { runTicketPrune } from '../lib/run.mjs';
import { renderReport, toJson } from '../lib/format.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const BIN = join(HERE, '..', 'bin', 'ticket-prune.mjs');

// The exact reason strings the contract fixes, spelled once here so a silent
// reword shows up as a test failure rather than as drifting prose.
const OFF_REASON = 'no explicit status; scope-existence inference is off (pass --infer-scope to enable it)';
const ON_REASON_RE = /^inferred: all 1 declared scope glob\(s\) resolve to tracked files on the base ref$/;

const TRACKED = ['plugins/adlc-widget/index.mjs', 'docs/integrations/widget.md'];

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function writeTickets(dir, tickets) {
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
}

function readTickets(dir) {
  return JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'));
}

/** Scratch repo with one shipped feature committed, mirroring run.test.mjs. */
function withScratchRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-prune-infer-'));
  try {
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    mkdirSync(join(dir, 'plugins', 'adlc-widget'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'adlc-widget', 'index.mjs'), '// shipped\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'ship the widget'], dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── AC1: inference is OFF by default ────────────────────────────────────────

test('AC1: with no options, a statusless ticket whose scope fully resolves is NOT stale', () => {
  const result = classifyTicket({ id: 'T1', scope: ['plugins/adlc-widget/**'] }, TRACKED);
  assert.equal(result.stale, false, 'scope existence alone must no longer mark a ticket shipped');
  assert.equal(result.reason, OFF_REASON);
});

test('AC1: an explicitly-passed inferScope:false behaves identically to omitting it', () => {
  const omitted = classifyTicket({ id: 'T1', scope: ['plugins/adlc-widget/**'] }, TRACKED);
  const explicit = classifyTicket({ id: 'T1', scope: ['plugins/adlc-widget/**'] }, TRACKED, { inferScope: false });
  assert.deepEqual(explicit, omitted);
});

test('AC1: the inference stays off even when EVERY glob resolves and there are several', () => {
  const result = classifyTicket(
    { id: 'T1', scope: ['plugins/adlc-widget/**', 'docs/integrations/widget.md'] },
    TRACKED,
  );
  assert.equal(result.stale, false);
  assert.equal(result.reason, OFF_REASON);
});

// ── AC2: inferScope:true reproduces today's classification byte-for-byte ─────

test('AC2: with inferScope:true the same ticket is stale, with the original reason string', () => {
  const result = classifyTicket({ id: 'T1', scope: ['plugins/adlc-widget/**'] }, TRACKED, { inferScope: true });
  assert.equal(result.stale, true);
  assert.match(result.reason, ON_REASON_RE);
});

test('AC2: with inferScope:true a partially-resolving scope is still active, with the original reason', () => {
  const result = classifyTicket(
    { id: 'T2', scope: ['plugins/adlc-widget/**', 'packages/never-built/**'] },
    TRACKED,
    { inferScope: true },
  );
  assert.equal(result.stale, false);
  assert.equal(result.reason, 'no explicit status; declared scope not fully present on the base ref');
});

test('AC2: a partially-resolving scope with the inference OFF reports the inference-off reason, not the not-present one', () => {
  // Both are "active", but they are different facts: one says the scope check
  // ran and failed, the other says it never ran. Collapsing them would hide
  // which classifier produced the count.
  const result = classifyTicket({ id: 'T2', scope: ['plugins/adlc-widget/**', 'packages/never-built/**'] }, TRACKED);
  assert.equal(result.stale, false);
  assert.equal(result.reason, OFF_REASON);
});

// ── AC3: explicit status and no-scope are decided identically in both modes ──

test('AC3: an explicit done-shaped status is stale in BOTH modes', () => {
  const ticket = { id: 'T1', status: 'done', scope: ['nowhere/**'] };
  for (const options of [undefined, { inferScope: false }, { inferScope: true }]) {
    const result = classifyTicket(ticket, [], options);
    assert.equal(result.stale, true, `explicit status must win with options=${JSON.stringify(options)}`);
    assert.equal(result.reason, 'explicit status: "done"');
  }
});

test('AC3: an explicit non-done status is active in BOTH modes and never reaches the inference', () => {
  const ticket = { id: 'T1', status: 'active', scope: ['plugins/adlc-widget/**'] };
  for (const options of [undefined, { inferScope: true }]) {
    const result = classifyTicket(ticket, TRACKED, options);
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'explicit status: "active"');
  }
});

test('AC3: a ticket with no declared scope keeps its own reason in BOTH modes', () => {
  const ticket = { id: 'T3', title: 'no scope' };
  for (const options of [undefined, { inferScope: true }]) {
    const result = classifyTicket(ticket, TRACKED, options);
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'no explicit status and no declared scope — cannot infer, treated as active');
  }
});

test('AC3: classifyTickets threads the same option through a whole array', () => {
  const tickets = [
    { id: 'T1', scope: ['plugins/adlc-widget/**'] },
    { id: 'T2', scope: ['packages/never-built/**'] },
    { id: 'T3', status: 'done' },
  ];
  assert.deepEqual(
    classifyTickets(tickets, TRACKED).map((r) => [r.id, r.stale]),
    [['T1', false], ['T2', false], ['T3', true]],
  );
  assert.deepEqual(
    classifyTickets(tickets, TRACKED, { inferScope: true }).map((r) => [r.id, r.stale]),
    [['T1', true], ['T2', false], ['T3', true]],
  );
});

// ── AC4: runTicketPrune writes nothing the inference alone marked stale ─────

test('AC4: --write with the default classifier tombstones nothing that only the inference marked stale', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] },
      { id: 'T2', title: 'Still building', scope: ['packages/never-built/**'] },
    ]);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');
    const result = runTicketPrune({ cwd: dir, write: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.stale, [], 'nothing may be stale without the inference');
    assert.deepEqual(result.tombstoned, []);
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before, 'tickets.json must be byte-untouched');
    assert.deepEqual(result.active.map((r) => r.id), ['T1', 'T2']);
  });
});

test('AC4: the same --write call with inferScope:true reproduces the old tombstone set', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] },
      { id: 'T2', title: 'Still building', scope: ['packages/never-built/**'] },
    ]);
    const result = runTicketPrune({ cwd: dir, write: true, inferScope: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.stale.map((r) => r.id), ['T1']);
    assert.deepEqual(result.tombstoned.map((t) => t.id), ['T1']);
    const after = readTickets(dir).tickets;
    assert.equal(after.find((t) => t.id === 'T1').completed, true);
    assert.equal('completed' in after.find((t) => t.id === 'T2'), false);
  });
});

test('AC4: an explicit done status is still tombstoned with the inference off', () => {
  // The fix must gate the INFERENCE only. An author-asserted done status is not
  // an inference, so --write must still act on it or the tool stops working.
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Marked done', status: 'done', scope: ['nowhere/**'] }]);
    const result = runTicketPrune({ cwd: dir, write: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tombstoned.map((t) => t.id), ['T1']);
    assert.equal(readTickets(dir).tickets[0].completed, true);
  });
});

test('AC4: the result carries inferScope so a caller can tell which classifier ran', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);
    assert.equal(runTicketPrune({ cwd: dir }).inferScope, false);
    assert.equal(runTicketPrune({ cwd: dir, inferScope: true }).inferScope, true);
  });
});

test('AC4: an empty ticket store still reports the mode', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, []);
    assert.equal(runTicketPrune({ cwd: dir }).inferScope, false);
    assert.equal(runTicketPrune({ cwd: dir, inferScope: true }).inferScope, true);
  });
});

// ── AC5: the mode is visible in both output shapes ──────────────────────────

test('AC5: renderReport states whether scope-existence inference was on or off', () => {
  const base = { baseRef: 'HEAD', write: false, stale: [], active: [] };
  const off = renderReport({ ...base, inferScope: false });
  const on = renderReport({ ...base, inferScope: true });
  assert.match(off, /scope-existence inference: off/);
  assert.match(on, /scope-existence inference: on/);
  assert.notEqual(off, on);
});

test('AC5: toJson carries inferScope', () => {
  const base = { baseRef: 'HEAD', write: false, stale: [], active: [] };
  assert.equal(toJson({ ...base, inferScope: false }).inferScope, false);
  assert.equal(toJson({ ...base, inferScope: true }).inferScope, true);
});

test('AC5: the CLI accepts --infer-scope and reflects it in --json', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);

    const off = spawnSync(process.execPath, [BIN, '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(off.status, 0, off.stderr);
    const offJson = JSON.parse(off.stdout);
    assert.equal(offJson.inferScope, false);
    assert.deepEqual(offJson.stale, []);

    const on = spawnSync(process.execPath, [BIN, '--json', '--infer-scope'], { cwd: dir, encoding: 'utf8' });
    assert.equal(on.status, 0, on.stderr);
    const onJson = JSON.parse(on.stdout);
    assert.equal(onJson.inferScope, true);
    assert.deepEqual(onJson.stale.map((r) => r.id), ['T1']);
  });
});

test('AC5: --infer-scope is documented in the usage string', () => {
  const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout + help.stderr, /--infer-scope/);
});

// ── AC6: the shipped CI recipe sees a sharded store ─────────────────────────

test('AC6: the maintenance recipe guards on BOTH store backends, not just the legacy flat file', () => {
  const recipe = readFileSync(join(REPO_ROOT, 'docs', 'ci', 'adlc-maintenance.yml'), 'utf8');
  // Match the shell statements themselves, not the prose around them: a comment
  // mentioning either path must not be able to satisfy this guard.
  const lines = recipe.split('\n').map((line) => line.trim()).filter((line) => !line.startsWith('#'));
  const guard = lines.find((line) => line.startsWith('if [') && line.includes('.adlc/tickets'));
  assert.ok(guard, 'the ticket-prune step must still guard on store existence');
  assert.match(guard, /\.adlc\/tickets\/\.store\.json/, 'the guard must also accept a sharded store');
  // The skip message must name both paths, or an operator reading the summary
  // is told the wrong thing about why the step did nothing.
  const skip = lines.find((line) => line.startsWith('echo') && line.includes('nothing to prune'));
  assert.ok(skip, 'the skip message must still exist');
  assert.match(skip, /\.adlc\/tickets\/\.store\.json/);
});

// ── the drift reporter keeps the inference it depends on ────────────────────

test('ceremony-drift explicitly opts INTO the inference, so its drift set is unchanged', () => {
  // scripts/ceremony-drift.mjs reports the needsCeremony set, which only exists
  // downstream of a STALE classification. Defaulting the inference off without
  // updating that call would silently empty its report — a second false green
  // introduced by this fix.
  const source = readFileSync(join(REPO_ROOT, 'scripts', 'ceremony-drift.mjs'), 'utf8');
  const call = source.slice(source.indexOf('runTicketPrune({'));
  assert.ok(call.startsWith('runTicketPrune({'), 'ceremony-drift must still call runTicketPrune');
  assert.match(call.slice(0, 400), /inferScope:\s*true/);
});
