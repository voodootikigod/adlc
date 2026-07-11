import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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

/** Like spawnMutateAfterDelay, but DELETES .adlc/tickets.json (via the fixture's
 * "__DELETE__" sentinel) instead of overwriting it — to drive the
 * "ticket file disappeared under the lock" branch. */
function spawnDeleteAfterDelay(dir, delayMs) {
  const script = join(HERE, 'fixtures', 'mutate-tickets-after-delay.mjs');
  const child = spawn(process.execPath, [script, dir, '__DELETE__', String(delayMs)], { stdio: 'inherit' });
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
    assert.deepEqual(result.tombstoned, []);
    assert.deepEqual(result.needsCeremony, []);

    // Not mutated: byte-identical to what was written before the run.
    const after = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');
    assert.equal(after, before);
  });
});

test('dry-run: an absolute --tickets path is honored, not joined onto cwd', () => {
  withScratchRepo((dir) => {
    // Place tickets.json somewhere entirely outside `dir` (which is itself the
    // cwd passed to runTicketPrune) to prove an absolute ticketsPath overrides
    // cwd instead of being concatenated onto it (path.join would produce
    // cwd + absolutePath).
    const outside = mkdtempSync(join(tmpdir(), 'ticket-prune-abs-'));
    try {
      const absTickets = join(outside, 'tickets.json');
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

      const result = runTicketPrune({ cwd: dir, ticketsPath: absTickets });

      assert.equal(result.ok, true);
      assert.deepEqual(result.stale.map((r) => r.id), ['T1']);
      assert.deepEqual(result.active.map((r) => r.id), ['T2']);
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

// ── --write tombstones in place (never removes) ─────────────────────────────

test('--write tombstones a rails-less stale ticket with completed:true IN PLACE, changing nothing else, and never removes it', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] },
      { id: 'T2', title: 'Still building', scope: ['packages/never-built/**'] },
    ]);

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, true);
    assert.deepEqual(result.tombstoned.map((t) => t.id), ['T1']);
    assert.ok(result.tombstoned[0].reason);
    assert.deepEqual(result.needsCeremony, []);

    const after = readTickets(dir);
    // No removal: both tickets are still present, in the same order.
    assert.deepEqual(after.tickets.map((t) => t.id), ['T1', 'T2']);
    // The stale one gained EXACTLY `completed: true` and nothing else changed.
    assert.deepEqual(after.tickets[0], {
      id: 'T1',
      title: 'Ship the widget',
      scope: ['plugins/adlc-widget/**'],
      completed: true,
    });
    // The active one is untouched — no stray completed field.
    assert.deepEqual(after.tickets[1], {
      id: 'T2',
      title: 'Still building',
      scope: ['packages/never-built/**'],
    });
  });
});

test('--write does NOT auto-tombstone a stale ticket that still freezes rails — it reports it under needsCeremony and leaves tickets.json untouched', () => {
  withScratchRepo((dir) => {
    const railed = {
      id: 'T1',
      title: 'Ship the widget',
      scope: ['plugins/adlc-widget/**'],
      rails: ['test/adlc-widget/**'],
    };
    writeTickets(dir, [railed]);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, true);
    // Completing it would expire its frozen rails — a privileged action the
    // gate reserves for the admin ceremony, so prune refuses to do it.
    assert.deepEqual(result.tombstoned, []);
    assert.deepEqual(result.needsCeremony.map((t) => t.id), ['T1']);
    assert.deepEqual(result.needsCeremony[0].rails, ['test/adlc-widget/**']);
    assert.equal(result.needsCeremony[0].blocker, 'rails-freeze');
    // tickets.json is byte-identical — no partial mutation of a railed ticket.
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before);
  });
});

test('#104 (codex): a rails-less stale ticket that ALREADY carries completed:false is NOT rewritten to true — that would be a base-ticket MUTATION the add-only gate denies; it is reported for the ceremony and tickets.json is left byte-untouched', () => {
  withScratchRepo((dir) => {
    // completed:false is a pre-existing field, not the pristine "no completed
    // field" the gate's add-only exemption accepts. The writer must mirror that
    // predicate exactly — rewriting false→true produces an unmergeable PR.
    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], completed: false },
    ]);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, true);
    assert.deepEqual(result.tombstoned, []);
    assert.deepEqual(result.needsCeremony.map((t) => t.id), ['T1']);
    assert.equal(result.needsCeremony[0].blocker, 'preexisting-completed-field');
    // Not rewritten: false stays false, byte-identical.
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before);
  });
});

test('--write with a mix: the rails-less stale ticket is tombstoned, the railed stale ticket is left for the ceremony', () => {
  withScratchRepo((dir) => {
    mkdirSync(join(dir, 'packages', 'second-widget'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'second-widget', 'index.mjs'), '// shipped later\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'ship the second widget'], dir);

    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] },
      {
        id: 'T2',
        title: 'Ship the second widget',
        scope: ['packages/second-widget/**'],
        rails: ['test/second-widget/**'],
      },
    ]);

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, true);
    assert.deepEqual(result.tombstoned.map((t) => t.id), ['T1']);
    assert.deepEqual(result.needsCeremony.map((t) => t.id), ['T2']);

    const after = readTickets(dir);
    assert.equal(after.tickets[0].completed, true); // T1 tombstoned
    assert.equal(after.tickets[1].completed, undefined); // T2 untouched
    assert.deepEqual(after.tickets[1].rails, ['test/second-widget/**']);
  });
});

test('--write with no stale tickets leaves tickets.json byte-untouched', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Still building', scope: ['packages/never-built/**'] }]);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.deepEqual(result.tombstoned, []);
    assert.deepEqual(result.needsCeremony, []);
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before);
  });
});

test('--write is idempotent: an already-tombstoned (completed:true) stale ticket is not re-tombstoned and tickets.json is left byte-untouched', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], completed: true },
    ]);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, true);
    // classifyTicket may still consider it stale, but it is already completed
    // so there is nothing to write.
    assert.deepEqual(result.tombstoned, []);
    assert.deepEqual(result.needsCeremony, []);
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before);
  });
});

// ── --write failure safety (no data loss, no uncaught exceptions) ──────────

test('--write: if the tickets.json write fails, the error is reported cleanly as {ok:false} instead of throwing', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);

    // Point --tickets at a path whose parent directory does not exist so the
    // atomic write throws (ENOENT). loadTickets reads it first and returns a
    // clean operational error before we ever reach the write, which is itself
    // the "no uncaught exception" guarantee we care about.
    const badTicketsPath = join(dir, 'nonexistent-dir', 'tickets.json');

    const result = runTicketPrune({ cwd: dir, ticketsPath: badTicketsPath, write: true });

    assert.equal(result.ok, false);
    assert.match(result.error, /not found|write/i);
  });
});

// ── concurrency: re-read under the lock ─────────────────────────────────────
//
// runTicketPrune re-reads tickets.json after acquiring the lock, specifically
// to guard against another writer (e.g. ticket-sync) mutating tickets.json
// between the initial classification read and the lock acquisition. These
// tests force a *real* concurrent mutation (via a child process that
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
    assert.deepEqual(result.tombstoned.map((t) => t.id), ['T1']);

    // T2 didn't exist when classification ran, so it's in neither `stale`
    // nor `active` — but the re-read under the lock must still see it and
    // preserve it in tickets.json. T1 gains completed:true; T2 is untouched.
    const after = readTickets(dir);
    assert.deepEqual(after.tickets.map((t) => t.id), ['T1', 'T2']);
    assert.equal(after.tickets[0].completed, true);
    assert.equal(after.tickets[1].completed, undefined);
  });
});

test('--write: if a stale ticket is already gone by the time the lock is acquired, the run tombstones nothing instead of crashing', () => {
  return withScratchRepoAsync(async (dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);

    assert.equal(acquireLock(dir), true);

    // Simulates another writer having already removed T1 by the time
    // ticket-prune gets the lock.
    const writerDone = spawnMutateAfterDelay(dir, { tickets: [] }, 150);

    const result = runTicketPrune({ cwd: dir, write: true });
    await writerDone;

    assert.equal(result.ok, true);
    // Classification (which ran before the lock was even attempted) still
    // reports T1 as stale...
    assert.deepEqual(result.stale.map((r) => r.id), ['T1']);
    // ...but the tombstoneIds.size === 0 early-return branch means nothing is
    // written.
    assert.deepEqual(result.tombstoned, []);
    assert.deepEqual(readTickets(dir).tickets, []);
  });
});

test('--write: if tickets.json is DELETED (not just mutated) between classification and the under-lock re-read, the run reports {ok:false, /disappeared/} instead of a false success or a crash', () => {
  return withScratchRepoAsync(async (dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);

    assert.equal(acquireLock(dir), true);

    // While ticket-prune is blocked on the lock, another actor removes the
    // ticket file entirely and releases the lock. The under-lock re-read then
    // sees no file (readJson → null), which must surface as a clean error.
    const writerDone = spawnDeleteAfterDelay(dir, 150);

    const result = runTicketPrune({ cwd: dir, write: true });
    await writerDone;

    assert.equal(result.ok, false);
    assert.match(result.error, /disappeared/);
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
    // ...but nothing gets tombstoned: the re-read-under-the-lock content no
    // longer classifies as stale, so the concurrent edit wins.
    assert.deepEqual(result.tombstoned, []);
    // The ticket survives in tickets.json with its fresh, active status and
    // no completed field forced onto it.
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
    assert.deepEqual(result.tombstoned, []);
    assert.deepEqual(result.needsCeremony, []);
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
    assert.deepEqual(parsed.tombstoned, []);
  });
});

test('bin: --write exits 0 and actually tombstones in place via the CLI entry point', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'] }]);
    const { code, stdout } = runBin(['--write', '--json'], dir);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.tombstoned.map((t) => t.id), ['T1']);
    const after = readTickets(dir);
    assert.deepEqual(after.tickets.map((t) => t.id), ['T1']);
    assert.equal(after.tickets[0].completed, true);
  });
});

test('bin: missing tickets file exits 1 (operational error)', () => {
  withScratchRepo((dir) => {
    const { code, stderr } = runBin([], dir);
    assert.equal(code, 1);
    assert.match(stderr, /tickets file not found/);
  });
});
