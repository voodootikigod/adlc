// checkFlail vs. the REAL flail-detector contract (T62 / #284).
//
// These tests deliberately drive the actual `adlc flail-detector` binary rather
// than an injected mock. The bug they guard against — checkFlail reading a
// `detected` field the detector has never emitted, and execFileSync throwing on
// the detector's exit-2 "flail" verdict — survived precisely because every
// existing fixture mocked `exec` with a shape the tool does not produce. A mock
// cannot catch drift from the thing it is pretending to be, so the contract
// tests below use no mock at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFlail, MAX_OUTPUT_BYTES } from '../lib/gates.mjs';
import { flailExec } from '../lib/live-deps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/fleet/test → repo root
const ADLC_BIN = resolve(HERE, '../../cli/bin/adlc.mjs');

/** Write `content` to a log file in a fresh temp dir and return its path. */
function makeLog(content) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-flail-'));
  const p = join(dir, 'session.log');
  writeFileSync(p, content);
  return p;
}

/**
 * Assert the detector really produced `expected` for these inputs before
 * asserting what checkFlail made of it.
 *
 * Without this, every real-CLI test below is satisfiable by a totally broken
 * ADLC_BIN: a spawn failure, an unresolvable @adlc/flail-detector, and a
 * genuine exit 1 all collapse into the same failOpen() shape. A test that
 * passes when the binary never ran would be the same fiction this file exists
 * to eliminate, so the exit code is pinned first and separately.
 */
function assertDetectorExits(expected, logFile, scope) {
  const args = ['flail-detector', '--json'];
  for (const g of scope ?? []) args.push(`--scope=${g}`);
  args.push('--', logFile);
  const probe = spawnSync(ADLC_BIN, args, { encoding: 'utf8' });
  assert.equal(probe.error, undefined, `precondition: ${ADLC_BIN} must be spawnable`);
  assert.equal(
    probe.status, expected,
    `precondition: detector must exit ${expected} here, got ${probe.status} (stderr: ${probe.stderr})`,
  );
  if (expected === 1) {
    // An UNINSTALLED @adlc/flail-detector also exits 1 (cli/lib/dispatch.mjs),
    // which would satisfy the check above while the detector never ran — the
    // precise ambiguity this helper exists to remove.
    assert.doesNotMatch(
      probe.stderr ?? '', /tool not installed|unknown tool/,
      'precondition: exit 1 must be the detector own operational error, not a missing detector',
    );
  }
  return probe;
}

// ---------------------------------------------------------------------------
// AC1 — a real flail verdict (detector exits 2) must be reported as flail:true
// ---------------------------------------------------------------------------

test('checkFlail reports flail:true for a REAL detector flail verdict (exit 2)', async () => {
  const log = makeLog('Writing /etc/passwd\n');
  assertDetectorExits(2, log, ['src/**']);

  const r = checkFlail(log, ['src/**'], { adlcBin: ADLC_BIN });

  assert.equal(r.flail, true, 'the detector said verdict:"flail" — checkFlail must agree');
  assert.notEqual(r.failedOpen, true, 'a verdict the detector actually produced is not a fail-open');
});

// ---------------------------------------------------------------------------
// AC6 — the detector's real signal objects survive the round trip
// ---------------------------------------------------------------------------

test('checkFlail propagates the detector real signal objects', async () => {
  const log = makeLog('Writing /etc/passwd\n');
  assertDetectorExits(2, log, ['src/**']);

  const { signals } = checkFlail(log, ['src/**'], { adlcBin: ADLC_BIN });

  assert.ok(Array.isArray(signals) && signals.length > 0, 'signals must not be dropped');
  assert.ok(
    signals.some((s) => s && s.type === 'scope-violation'),
    `expected a scope-violation signal object, got ${JSON.stringify(signals)}`,
  );
});

// ---------------------------------------------------------------------------
// AC2 — a real clean verdict (exit 0) is a verdict, not a fallback
// ---------------------------------------------------------------------------

test('checkFlail reports flail:false for a REAL detector clean verdict (exit 0)', async () => {
  const log = makeLog('all good\nbuild succeeded\n');
  assertDetectorExits(0, log, ['src/**']);

  const r = checkFlail(log, ['src/**'], { adlcBin: ADLC_BIN });

  assert.equal(r.flail, false);
  assert.notEqual(r.failedOpen, true, 'exit 0 is a real clean verdict, not the §12 fallback');
});

// ---------------------------------------------------------------------------
// AC5 — an operational error (exit 1) still fails OPEN, and never flail:true
// ---------------------------------------------------------------------------

test('checkFlail FAILS OPEN on a real detector operational error (exit 1)', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'fleet-flail-')), 'does-not-exist.log');
  // Pin that this is a real exit-1 operational error and not a dead binary.
  assertDetectorExits(1, missing, ['src/**']);

  const r = checkFlail(missing, ['src/**'], { adlcBin: ADLC_BIN });

  assert.equal(r.flail, false, 'an operational error must never be reported as a flail');
  assert.equal(r.failedOpen, true, '§12: an unverifiable signal must not cut a build short');
});

// ---------------------------------------------------------------------------
// AC3/AC4 — the §12 backstop still holds for unverifiable outcomes
// ---------------------------------------------------------------------------

test('checkFlail FAILS OPEN when exec throws without a detector verdict (§12)', async () => {
  const r = checkFlail('/log', [], { exec: () => { throw new Error('adlc not found'); } });

  assert.deepEqual(r, { flail: false, signals: [], failedOpen: true });
});

test('checkFlail FAILS OPEN on malformed JSON (§12)', async () => {
  const r = checkFlail('/log', [], { exec: () => 'not json at all' });

  assert.deepEqual(r, { flail: false, signals: [], failedOpen: true });
});

test('checkFlail FAILS OPEN on a JSON document with no recognized verdict (§12)', async () => {
  // Schema-drift guard: if the detector ever renames or revalues `verdict`,
  // checkFlail must fail open rather than silently reporting sessions clean.
  // Deliberately NOT spelled with the old fictional field name — AC7 requires
  // that no fixture in this tree presents a `detected` key as detector output.
  const r = checkFlail('/log', [], { exec: () => JSON.stringify({ verdict: 'inconclusive', signals: [] }) });

  assert.equal(r.flail, false);
  assert.equal(r.failedOpen, true, 'an unrecognized document is unverifiable, not clean');
});

test('checkFlail FAILS OPEN when signals drifted to a non-array (§12)', async () => {
  // `signals` gets the same strictness as `verdict` — the documented return
  // shape is an array, so a drifted scalar must not escape into consumers.
  const r = checkFlail('/log', [], { exec: () => JSON.stringify({ verdict: 'flail', signals: 'scope-violation' }) });

  assert.equal(r.flail, false);
  assert.equal(r.failedOpen, true);
});

// ---------------------------------------------------------------------------
// A ticket's own scope globs must not be able to switch its supervision off.
// The detector parses with node:util.parseArgs in STRICT mode, where a bare
// `--scope -weird/**` is a parse error (exit 1) that checkFlail would then fail
// open on — so the args are built with `--opt=value` and a `--` terminator.
// ---------------------------------------------------------------------------

test('a scope glob beginning with "-" does not disable the gate', async () => {
  const log = makeLog('Writing /etc/passwd\n');
  assertDetectorExits(2, log, ['-weird/**']);

  const r = checkFlail(log, ['-weird/**'], { adlcBin: ADLC_BIN });

  assert.equal(r.flail, true, 'a dash-leading glob must not collapse into a fail-open');
  assert.notEqual(r.failedOpen, true);
});

test('a log path beginning with "-" is passed as a path, not parsed as a flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-flail-'));
  const p = join(dir, '-dash.log');
  writeFileSync(p, 'Writing /etc/passwd\n');
  assertDetectorExits(2, p, ['src/**']);

  const r = checkFlail(p, ['src/**'], { adlcBin: ADLC_BIN });

  assert.equal(r.flail, true);
});

// ---------------------------------------------------------------------------
// The injected-exec contract mirrors execFileSync: non-zero exit throws, and
// the error carries `status` + `stdout`. Documented here so a future mock
// cannot drift back into fiction.
// ---------------------------------------------------------------------------

test('injected exec may signal the flail verdict the way execFileSync does (throw w/ status 2)', async () => {
  const doc = JSON.stringify({ verdict: 'flail', signals: [{ type: 'edit-churn' }] });

  const r = checkFlail('/log', [], {
    exec: () => {
      const e = new Error('Command failed');
      e.status = 2;
      e.stdout = doc;
      throw e;
    },
  });

  assert.equal(r.flail, true);
  assert.deepEqual(r.signals, [{ type: 'edit-churn' }]);
});

// ---------------------------------------------------------------------------
// The production wiring does NOT use defaultExec: live-deps.mjs injects an
// adapter over `spawnSync`, which does not throw on a non-zero exit. That is
// the path that actually runs between build strikes, so it is driven here as
// the REAL exported function — importing it, not re-implementing it. A copy
// could not catch drift in the thing it copies, which is how #284 shipped.
// ---------------------------------------------------------------------------

/** io shim whose `adlc` is spawnSync over the real binary, as production's is. */
const realIo = { adlc: (args, opts = {}) => spawnSync(opts.bin ?? 'adlc', args, { encoding: 'utf8' }) };

test('the production flailExec adapter reports a REAL flail verdict', async () => {
  const log = makeLog('Writing /etc/passwd\n');
  assertDetectorExits(2, log, ['src/**']);

  const r = checkFlail(log, ['src/**'], { adlcBin: ADLC_BIN, exec: flailExec(realIo) });

  assert.equal(r.flail, true, 'the path fleet actually runs must see the flail');
  assert.notEqual(r.failedOpen, true);
});

test('the production flailExec adapter fails open on a real operational error', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'fleet-flail-')), 'nope.log');
  assertDetectorExits(1, missing, ['src/**']);

  const r = checkFlail(missing, ['src/**'], { adlcBin: ADLC_BIN, exec: flailExec(realIo) });

  assert.equal(r.flail, false);
  assert.equal(r.failedOpen, true);
});

test('flailExec honors the bin it is handed rather than discarding it', async () => {
  const seen = [];
  const exec = flailExec({ adlc: (args, opts) => { seen.push(opts?.bin); return { status: 0, stdout: '{"verdict":"clean","signals":[]}' }; } });

  checkFlail('/log', [], { adlcBin: '/custom/path/adlc', exec });

  assert.deepEqual(seen, ['/custom/path/adlc'], 'the configured bin must not be discarded');
  // NB: `config.adlcBin` is not currently surfaced by resolveRunConfig, so no
  // operator can set this today — flail-e2e.test.mjs proves the plumbing works
  // end to end through buildLiveDeps, but the config key remains unwired.
});

test('flailExec applies the same output cap as defaultExec', async () => {
  // Production runs through flailExec, NOT defaultExec, so a cap set only on
  // the latter would be inert exactly where the noisiest sessions are.
  let seen;
  const exec = flailExec({ adlc: (args, opts) => { seen = opts; return { status: 0, stdout: '{"verdict":"clean","signals":[]}' }; } });

  checkFlail('/log', [], { exec });

  assert.equal(seen.maxBuffer, MAX_OUTPUT_BYTES, 'both runners must share one limit');
});

test('flailExec turns exit 1 into a fail-open even when it printed a flail document', async () => {
  // The whole point of routing both paths through one trust rule: spawnSync
  // does not throw, so without this conversion the exit code would be dropped
  // and an operational error would be promoted to a verdict.
  const exec = flailExec({
    adlc: () => ({ status: 1, stdout: JSON.stringify({ verdict: 'flail', signals: [{ type: 'size' }] }) }),
  });

  const r = checkFlail('/log', [], { exec });

  assert.equal(r.flail, false, 'exit 1 is an operational error, not a verdict');
  assert.equal(r.failedOpen, true);
});

test('flailExec fails open when the detector could not be spawned at all', async () => {
  const exec = flailExec({ adlc: () => ({ error: new Error('ENOENT'), status: null, stdout: '' }) });

  const r = checkFlail('/log', [], { exec });

  assert.equal(r.failedOpen, true);
});

test('flailExec fails open when there is no exit status to trust', async () => {
  const exec = flailExec({ adlc: () => ({ status: null, stdout: '{"verdict":"flail","signals":[]}' }) });

  const r = checkFlail('/log', [], { exec });

  assert.equal(r.flail, false, 'a run with no exit status is unverifiable, not a verdict');
  assert.equal(r.failedOpen, true);
});

test('a thrown exec with status 1 is an operational error, not a verdict', async () => {
  const r = checkFlail('/log', [], {
    exec: () => {
      const e = new Error('Command failed');
      e.status = 1;
      e.stdout = '';
      throw e;
    },
  });

  assert.equal(r.flail, false);
  assert.equal(r.failedOpen, true);
});

test('exit 1 fails open even when it printed a well-formed flail document', async () => {
  // The exit code is what says "this run is trustworthy", not the document.
  // Only exit 2 means "I ran fine and the verdict is flail" — a status-1 run
  // that happens to emit parseable output must not be promoted to a verdict.
  const r = checkFlail('/log', [], {
    exec: () => {
      const e = new Error('Command failed');
      e.status = 1;
      e.stdout = JSON.stringify({ verdict: 'flail', signals: [{ type: 'size' }] });
      throw e;
    },
  });

  assert.equal(r.flail, false, 'an operational error is never a flail verdict');
  assert.equal(r.failedOpen, true);
});
