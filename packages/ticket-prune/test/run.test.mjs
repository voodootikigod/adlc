import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTicketPrune } from '../lib/run.mjs';
import { acquireLock } from '../lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'ticket-prune.mjs');

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

function readArchive(dir) {
  return JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.archive.json'), 'utf8'));
}

/**
 * A scratch repo with one shipped feature (plugins/adlc-widget/**, committed)
 * standing in for "mocked done signals": a ticket whose scope matches it is
 * inferrable-stale; a ticket whose scope points nowhere real is not.
 */
function setupScratchRepo(dir) {
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, 'plugins', 'adlc-widget'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'adlc-widget', 'index.mjs'), '// shipped\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'ship the widget'], dir);
}

function withScratchRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-prune-run-'));
  try {
    setupScratchRepo(dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Async variant: awaits `fn(dir)` before cleanup, for tests that spawn a
 * concurrent child process and need the temp dir to outlive its own return. */
async function withScratchRepoAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-prune-run-async-'));
  try {
    setupScratchRepo(dir);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Spawns a real child process that sleeps `delayMs`, overwrites
 * .adlc/tickets.json with `ticketsObj`, then releases the .adlc/tickets.lock
 * — simulating another writer (e.g. ticket-sync) mutating tickets.json and
 * releasing the lock while ticket-prune is blocked retrying for it. Runs
 * out-of-process so it isn't blocked by acquireLock's synchronous retry
 * loop in the test process. Returns a promise that resolves when the child
 * exits (rejects on nonzero exit).
 */
function spawnMutateAfterDelay(dir, ticketsObj, delayMs) {
  const script = join(HERE, 'fixtures', 'mutate-tickets-after-delay.mjs');
  const child = spawn(process.execPath, [script, dir, JSON.stringify(ticketsObj), String(delayMs)], {
    stdio: 'inherit',
  });
  return new Promise((resolvePromise, reject) => {
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`writer helper exited ${code}`))));
    child.on('error', reject);
  });
}

// ── dry-run reports without mutating ────────────────────────────────────────

test('dry-run reports a stale ticket (mocked done signal: shipped scope) without mutating tickets.json', () => {
  withScratchRepo((dir) => {
    const tickets = [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] },
      { id: 'T2', title: 'Still building', scope: ['packages/never-built/**'] },
    ];
    writeTickets(dir, tickets);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    const result = runTicketPrune({ cwd: dir });

    assert.equal(result.ok, true);
    assert.equal(result.write, false);
    assert.deepEqual(result.stale.map((r) => r.id), ['T1']);
    assert.deepEqual(result.active.map((r) => r.id), ['T2']);

    // Not mutated: byte-identical to what was written before the run.
    const after = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');
    assert.equal(after, before);
    assert.equal(existsSync(join(dir, '.adlc', 'tickets.archive.json')), false);
  });
});

test('dry-run: absolute --tickets/--archive paths are honored, not joined onto cwd', () => {
  withScratchRepo((dir) => {
    // Place tickets.json and the archive somewhere entirely outside `dir`
    // (which is itself the cwd passed to runTicketPrune) to prove an
    // absolute ticketsPath/archivePath overrides cwd instead of being
    // concatenated onto it (path.join would produce cwd + absolutePath).
    const outside = mkdtempSync(join(tmpdir(), 'ticket-prune-abs-'));
    try {
      const absTickets = join(outside, 'tickets.json');
      const absArchive = join(outside, 'tickets.archive.json');
      writeFileSync(
        absTickets,
        JSON.stringify(
          {
            tickets: [
              { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] },
              { id: 'T2', title: 'Still building', scope: ['packages/never-built/**'] },
            ],
          },
          null,
          2,
        ),
      );

      const result = runTicketPrune({ cwd: dir, ticketsPath: absTickets, archivePath: absArchive });

      assert.equal(result.ok, true);
      assert.deepEqual(result.stale.map((r) => r.id), ['T1']);
      assert.deepEqual(result.active.map((r) => r.id), ['T2']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('--write with an absolute --archive path archives outside cwd correctly', () => {
  withScratchRepo((dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'ticket-prune-abs-write-'));
    try {
      writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);
      const absArchive = join(outside, 'tickets.archive.json');

      const result = runTicketPrune({ cwd: dir, archivePath: absArchive, write: true });

      assert.equal(result.ok, true);
      assert.deepEqual(result.archived.map((t) => t.id), ['T1']);
      assert.equal(existsSync(absArchive), true);
      assert.deepEqual(JSON.parse(readFileSync(absArchive, 'utf8')).tickets.map((t) => t.id), ['T1']);
      // Default (relative) tickets.json location is unaffected.
      assert.deepEqual(readTickets(dir).tickets, []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('dry-run: an explicit non-done status overrides a shipped-looking scope', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'T1', title: 'Explicitly still active', status: 'active', scope: ['plugins/adlc-widget/**'] },
    ]);
    const result = runTicketPrune({ cwd: dir });
    assert.deepEqual(result.stale, []);
    assert.equal(result.active.length, 1);
  });
});

test('dry-run: explicit status "done" is stale even with no matching scope', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Marked done', status: 'done', scope: ['nowhere/**'] }]);
    const result = runTicketPrune({ cwd: dir });
    assert.deepEqual(result.stale.map((r) => r.id), ['T1']);
  });
});

// ── --write archives and removes ────────────────────────────────────────────

test('--write moves stale tickets into the archive file and removes them from tickets.json', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] },
      { id: 'T2', title: 'Still building', scope: ['packages/never-built/**'] },
    ]);

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, true);
    assert.equal(result.archived.length, 1);
    assert.equal(result.archived[0].id, 'T1');

    const remaining = readTickets(dir);
    assert.deepEqual(remaining.tickets.map((t) => t.id), ['T2']);

    const archive = readArchive(dir);
    assert.deepEqual(archive.tickets.map((t) => t.id), ['T1']);
    assert.ok(archive.tickets[0].archivedAt);
    assert.ok(archive.tickets[0].archiveReason);
    // Full ticket payload is preserved, not just the id.
    assert.equal(archive.tickets[0].title, 'Ship the widget');
  });
});

test('--write with no stale tickets leaves tickets.json untouched and writes no archive', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Still building', scope: ['packages/never-built/**'] }]);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.archived.length, 0);
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before);
    assert.equal(existsSync(join(dir, '.adlc', 'tickets.archive.json')), false);
  });
});

test('--write accumulates across repeated runs instead of clobbering the archive', () => {
  withScratchRepo((dir) => {
    mkdirSync(join(dir, 'packages', 'second-widget'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'second-widget', 'index.mjs'), '// shipped later\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'ship the second widget'], dir);

    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] },
      { id: 'T2', title: 'Ship the second widget', scope: ['packages/second-widget/**'] },
    ]);

    runTicketPrune({ cwd: dir, write: true });
    let archive = readArchive(dir);
    assert.deepEqual(archive.tickets.map((t) => t.id).sort(), ['T1', 'T2']);

    // A later run with a fresh tickets.json (e.g. new tickets added since)
    // must not drop the earlier archive entries.
    writeTickets(dir, [{ id: 'T3', title: 'Still building', scope: ['packages/never-built/**'] }]);
    runTicketPrune({ cwd: dir, write: true });
    archive = readArchive(dir);
    assert.deepEqual(archive.tickets.map((t) => t.id).sort(), ['T1', 'T2']);
  });
});

// ── --write failure safety (no data loss, no uncaught exceptions) ──────────

test('--write: if the archive write fails, tickets.json is left untouched (no data loss) and the error is reported cleanly', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    // Point --archive at a path inside a directory that doesn't exist, so
    // the archive's atomic write throws (ENOENT).
    const badArchivePath = join(dir, 'nonexistent-dir', 'tickets.archive.json');

    const result = runTicketPrune({ cwd: dir, archivePath: badArchivePath, write: true });

    assert.equal(result.ok, false);
    assert.match(result.error, /archive/i);

    // The stale ticket must still be in tickets.json, byte-identical to
    // before the failed run — archive-write failures must never remove a
    // ticket from tickets.json without it having been durably archived.
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before);
    assert.equal(existsSync(badArchivePath), false);
  });
});

test('--write: invalid JSON in a pre-existing archive file is a clean {ok:false} error, not an uncaught exception, and does not touch tickets.json', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');
    writeFileSync(join(dir, '.adlc', 'tickets.archive.json'), '{ not valid json');

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, false);
    assert.match(result.error, /invalid JSON/);
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before);
  });
});

test('--write: a pre-existing archive file containing the JSON literal `null` (syntactically valid, but not an object) archives cleanly instead of throwing', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);
    // `null` is valid JSON — readJson's fallback is only used for a missing
    // file, so this parses successfully to `null`, not { tickets: [] }.
    writeFileSync(join(dir, '.adlc', 'tickets.archive.json'), 'null');

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, true);
    assert.equal(result.archived.length, 1);
    assert.equal(result.archived[0].id, 'T1');

    const archive = readArchive(dir);
    assert.equal(archive.tickets.length, 1);
    assert.equal(archive.tickets[0].id, 'T1');

    const tickets = readTickets(dir);
    assert.equal(tickets.tickets.length, 0);
  });
});

test('bin: --write with a corrupt archive file exits 1 with a clean error message, not a raw stack trace', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);
    writeFileSync(join(dir, '.adlc', 'tickets.archive.json'), '{ not valid json');

    const { code, stderr } = runBin(['--write', '--json'], dir);

    assert.equal(code, 1);
    assert.match(stderr, /^error: /);
    assert.doesNotMatch(stderr, /at runTicketPrune/); // no raw Node stack trace
  });
});

// ── concurrency: re-read under the lock ─────────────────────────────────────
//
// runTicketPrune re-reads tickets.json after acquiring the lock, specifically
// to guard against another writer (e.g. ticket-sync) mutating tickets.json
// between the initial classification read and the lock acquisition. These
// two tests force a *real* concurrent mutation (via a child process that
// holds/releases the shared lock out-of-process) to exercise that re-read,
// rather than two sequential non-overlapping runs.

test('--write: re-reads tickets.json under the lock, so a ticket added concurrently (after classification, before the lock) survives the write', async () => {
  await withScratchRepoAsync(async (dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);

    // Hold the lock ourselves first so runTicketPrune's own acquireLock()
    // call is forced to block/retry — simulating another writer being
    // mid-write at the exact moment ticket-prune tries to take the lock.
    assert.equal(acquireLock(dir), true);

    // While ticket-prune is blocked on the lock, this child process mutates
    // tickets.json to add T2 (unknown to classification, which already ran
    // against the pre-mutation file above) and then releases the lock.
    const mutated = {
      tickets: [
        { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] },
        { id: 'T2', title: 'Added concurrently', scope: ['packages/never-built/**'] },
      ],
    };
    const writerDone = spawnMutateAfterDelay(dir, mutated, 150);

    const result = runTicketPrune({ cwd: dir, write: true });
    await writerDone;

    assert.equal(result.ok, true);
    assert.deepEqual(result.archived.map((t) => t.id), ['T1']);

    // T2 didn't exist when classification ran, so it's in neither `stale`
    // nor `active` — but the re-read under the lock must still see it and
    // preserve it in tickets.json. If runTicketPrune used the pre-lock
    // `tickets` snapshot instead of re-reading fresh under the lock, T2
    // would be silently dropped here.
    assert.deepEqual(readTickets(dir).tickets.map((t) => t.id), ['T2']);
  });
});

test('--write: if a stale ticket is already gone by the time the lock is acquired, the run archives nothing instead of crashing or re-archiving', () => {
  return withScratchRepoAsync(async (dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);

    assert.equal(acquireLock(dir), true);

    // Simulates another writer having already archived/removed T1 by the
    // time ticket-prune gets the lock.
    const writerDone = spawnMutateAfterDelay(dir, { tickets: [] }, 150);

    const result = runTicketPrune({ cwd: dir, write: true });
    await writerDone;

    assert.equal(result.ok, true);
    // Classification (which ran before the lock was even attempted) still
    // reports T1 as stale...
    assert.deepEqual(result.stale.map((r) => r.id), ['T1']);
    // ...but the removed.length === 0 early-return branch means nothing is
    // (re-)archived and no archive file is created.
    assert.deepEqual(result.archived, []);
    assert.equal(existsSync(join(dir, '.adlc', 'tickets.archive.json')), false);
    assert.deepEqual(readTickets(dir).tickets, []);
  });
});

test('--write: a ticket concurrently un-staled (status flipped back to active) between classification and the lock survives, using fresh content and reclassification, not the stale pre-lock snapshot', () => {
  return withScratchRepoAsync(async (dir) => {
    // T1 starts "done" — classification (pre-lock) reports it stale.
    writeTickets(dir, [{ id: 'T1', title: 'Reopened work', status: 'done' }]);

    assert.equal(acquireLock(dir), true);

    // While ticket-prune is blocked on the lock, another writer flips T1
    // back to "in-progress" — it is no longer stale by any classification
    // rule, even though the pre-lock snapshot said otherwise.
    const mutated = { tickets: [{ id: 'T1', title: 'Reopened work', status: 'in-progress' }] };
    const writerDone = spawnMutateAfterDelay(dir, mutated, 150);

    const result = runTicketPrune({ cwd: dir, write: true });
    await writerDone;

    assert.equal(result.ok, true);
    // Pre-lock classification still (correctly, for its snapshot) reported
    // T1 as stale...
    assert.deepEqual(result.stale.map((r) => r.id), ['T1']);
    // ...but nothing gets archived: the re-read-under-the-lock content no
    // longer classifies as stale, so the concurrent edit wins.
    assert.deepEqual(result.archived, []);
    assert.equal(existsSync(join(dir, '.adlc', 'tickets.archive.json')), false);
    // The ticket survives in tickets.json with its fresh, active status.
    assert.deepEqual(readTickets(dir).tickets, [{ id: 'T1', title: 'Reopened work', status: 'in-progress' }]);
  });
});

test('empty tickets.json (no tickets) reports cleanly and is a no-op', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, []);
    const result = runTicketPrune({ cwd: dir });
    assert.equal(result.ok, true);
    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.active, []);
  });
});

test('missing tickets.json is an operational error, not a silent pass', () => {
  withScratchRepo((dir) => {
    const result = runTicketPrune({ cwd: dir });
    assert.equal(result.ok, false);
    assert.match(result.error, /tickets file not found/);
  });
});

// ── bin smoke test (exit codes + --json shape) ──────────────────────────────

function runBin(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

test('bin: dry-run exits 0 and --json prints the classification', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);
    const { code, stdout } = runBin(['--json'], dir);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.write, false);
    assert.deepEqual(parsed.stale.map((r) => r.id), ['T1']);
  });
});

test('bin: --write exits 0 and actually archives via the CLI entry point', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);
    const { code } = runBin(['--write', '--json'], dir);
    assert.equal(code, 0);
    assert.deepEqual(readTickets(dir).tickets, []);
    assert.equal(readArchive(dir).tickets.length, 1);
  });
});

test('bin: missing tickets file exits 1 (operational error)', () => {
  withScratchRepo((dir) => {
    const { code, stderr } = runBin([], dir);
    assert.equal(code, 1);
    assert.match(stderr, /tickets file not found/);
  });
});
