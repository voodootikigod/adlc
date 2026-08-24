import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTicketPrune } from '../lib/run.mjs';
import { renderReport, toJson } from '../lib/format.mjs';
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

    const result = runTicketPrune({ cwd: dir, write: true, key: 'test-manifest-key' });

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

// ── #198: dry-run surfaces the ceremony drift; --ceremony completes it ───────
//
// A railed shipped ticket can only be completed (which expires its rails, T36)
// through the protected-base admin ceremony. ticket-prune must (a) surface that
// set in DRY-RUN so the drift is visible before it blocks a PR, and (b) apply the
// completion under --ceremony, but only with the recorded admin override.

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  }
}

test('#198 AC1: dry-run surfaces a railed shipped ticket under needsCeremony (blocker rails-freeze) without mutating tickets.json', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      {
        id: 'T1',
        title: 'Ship the widget',
        scope: ['plugins/adlc-widget/**'],
        rails: ['test/adlc-widget/**'],
      },
      { id: 'T2', title: 'Still building', scope: ['packages/never-built/**'] },
    ]);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    const result = runTicketPrune({ cwd: dir }); // dry-run, no --write

    assert.equal(result.ok, true);
    assert.equal(result.write, false);
    // The railed shipped ticket is reported for the ceremony — in DRY-RUN, which
    // today would be empty. This is the visibility fix.
    assert.deepEqual(result.needsCeremony.map((c) => c.id), ['T1']);
    assert.equal(result.needsCeremony[0].blocker, 'rails-freeze');
    assert.deepEqual(result.needsCeremony[0].rails, ['test/adlc-widget/**']);
    // Nothing written.
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before);
  });
});

test('#198 AC1: dry-run surfaces a rails-less preexisting-completed-field ticket under needsCeremony', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], completed: false },
    ]);
    const result = runTicketPrune({ cwd: dir }); // dry-run
    assert.deepEqual(result.needsCeremony.map((c) => c.id), ['T1']);
    assert.equal(result.needsCeremony[0].blocker, 'preexisting-completed-field');
  });
});

// ---- #208: --ceremony is deprecated (was #198's ceremony-completion path) ----
//
// It completed rail-freezing tickets in place: bulk (no ids, recomputed set —
// TOCTOU + blast radius), evidence-less (a direct write, no manifest), and
// legacy-store-only. The canonical `adlc ticket complete <id> --write --authorize
// --json` replaces it. runTicketPrune now fails closed on ceremony:true, and the
// tests below cover the deprecation plus the behavior that REMAINS: --write still
// tombstones rails-less stale tickets, and rail-freezing / preexisting-completed
// entries are reported (never completed here).

test('#208: runTicketPrune with ceremony:true fails closed and mutates nothing, regardless of ADLC_RAILS_BYPASS', () => {
  for (const bypass of [undefined, '1']) {
    withEnv('ADLC_RAILS_BYPASS', bypass, () => {
      withScratchRepo((dir) => {
        writeTickets(dir, [
          { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], rails: ['test/adlc-widget/**'] },
        ]);
        const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');
        const result = runTicketPrune({ cwd: dir, ceremony: true });
        assert.equal(result.ok, false);
        assert.match(result.error, /deprecated/);
        assert.match(result.error, /adlc ticket complete <id> --write --authorize --json/);
        assert.doesNotMatch(result.error, /ADLC_RAILS_BYPASS/); // the old gate is gone
        assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before);
      });
    });
  }
});

test('#208: --write still tombstones a rails-less stale ticket; a railed one is only reported under needsCeremony', () => {
  withScratchRepo((dir) => {
    mkdirSync(join(dir, 'packages', 'second-widget'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'second-widget', 'index.mjs'), '// shipped later\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'ship the second widget'], dir);

    writeTickets(dir, [
      { id: 'T1', title: 'rails-less shipped', scope: ['plugins/adlc-widget/**'] },
      { id: 'T2', title: 'railed shipped', scope: ['packages/second-widget/**'], rails: ['test/second-widget/**'] },
    ]);

    const result = runTicketPrune({ cwd: dir, write: true, key: 'test-manifest-key' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.tombstoned.map((t) => t.id), ['T1']);           // rails-less → tombstoned
    assert.deepEqual(result.ceremonyCompleted, []);                          // nothing completed in-place
    assert.deepEqual(result.needsCeremony.map((c) => c.id), ['T2']);         // railed → only reported
    assert.equal(result.needsCeremony[0].blocker, 'rails-freeze');

    const after = readTickets(dir);
    assert.equal(after.tickets[0].completed, true);   // T1 tombstoned
    assert.equal(after.tickets[1].completed, undefined); // T2 untouched — completed via `adlc ticket complete`
  });
});

// This path rewrites tickets.json DIRECTLY, so the audited-override contract the
// ticket store enforces in TicketService does not reach it. A mixed store — one
// railed ticket, one stale rails-less one — is still a frozen trust root, and
// tombstoning inside it rewrites the file that holds the rail configuration.
// Without the guard below, this is a way to mutate a frozen store keylessly with a
// successful exit and no record at all.
test('a keyless --write REFUSES when any ticket in the store declares a rail, and mutates nothing', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'RAILED', title: 'railed in-flight', scope: ['packages/never-built/**'], rails: ['src/guarded/**'] },
      { id: 'RAILLESS', title: 'shipped', scope: ['plugins/adlc-widget/**'], rails: [] },
    ]);
    const ticketsPath = join(dir, '.adlc', 'tickets.json');
    const before = readFileSync(ticketsPath, 'utf8');

    assert.throws(
      () => runTicketPrune({ cwd: dir, write: true }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
    );
    assert.equal(readFileSync(ticketsPath, 'utf8'), before, 'tickets.json is byte-identical');

    // With a key the tombstone lands as before — the gate refuses the unsignable
    // write, it does not refuse the work — and it is RECORDED. Refusing without
    // recording would have left the invariant half-true: the writes that got
    // through would still be invisible.
    const result = runTicketPrune({ cwd: dir, write: true, key: 'test-manifest-key' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tombstoned.map((t) => t.id), ['RAILLESS']);

    const entries = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.equal(entries.length, 1, 'one write, one audit entry');
    assert.equal(entries[0].gate, 'ticket-mutation');
    assert.equal(entries[0].data.op, 'prune');
    assert.equal(entries[0].data.bypass, true);
    assert.ok(entries[0].sig, 'and it is signed');
    assert.notEqual(entries[0].data.storeHashBefore, entries[0].data.storeHashAfter,
      'the entry binds the store either side of a real change');
    // Store hashes prove that something changed; the ids say what this entry
    // authorized, which is what an auditor reading only the manifest needs.
    assert.deepEqual(entries[0].data.ticketIds, ['RAILLESS']);
  });
});

// The first half of the split write. A staging failure has to be reported as a
// FAILED sweep: returning ok:true here would tell automation the tombstones landed
// when tickets.json is exactly as it was.
test('a staging failure is reported as a failed sweep, not a silent no-op', () => {
  withScratchRepo((dir) => {
    // The store lives in its own read-only directory, so the staged temp file
    // cannot be created while the lock (which lives under cwd/.adlc) still can.
    const readOnly = mkdtempSync(join(tmpdir(), 'ticket-prune-ro-'));
    const ticketsPath = join(readOnly, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({
      tickets: [{ id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], rails: [] }],
    }, null, 2));
    const before = readFileSync(ticketsPath, 'utf8');
    chmodSync(readOnly, 0o555);
    try {
      const result = runTicketPrune({ cwd: dir, ticketsPath, write: true });
      assert.equal(result.ok, false, 'the sweep failed and says so');
      assert.match(result.error, /failed to write completions/);
      assert.equal(readFileSync(ticketsPath, 'utf8'), before);
    } finally {
      chmodSync(readOnly, 0o755);
      rmSync(readOnly, { recursive: true, force: true });
    }
  });
});

function manifestEntries(dir) {
  const path = join(dir, '.adlc', 'manifest.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** A stager whose staging succeeds and whose commit blows up — the one failure the
 * ordering leaves a window for, and one the filesystem cannot produce on demand
 * (the staged copy and the rename that commits it share a directory). */
function stagerThatFailsToCommit(onCommit = () => {}) {
  return () => ({
    commit: () => { onCommit(); throw new Error('rename exploded'); },
    discard: () => {},
  });
}

// The second half of the split write. By the time the rename runs the entry is
// already appended, so a failure here leaves the append-only ledger naming a store
// hash the store never reached. The entry cannot be retracted — so it is
// CORRECTED: a second entry says the store stayed where it started, and a reader of
// the ledger alone is told the truth instead of a claim the store contradicts.
test('a rename failure is corrected in the ledger, not left standing as a false claim', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'RAILED', title: 'railed in-flight', scope: ['packages/never-built/**'], rails: ['src/guarded/**'] },
      { id: 'RAILLESS', title: 'shipped', scope: ['plugins/adlc-widget/**'], rails: [] },
    ]);
    const ticketsPath = join(dir, '.adlc', 'tickets.json');
    const before = readFileSync(ticketsPath, 'utf8');

    const result = runTicketPrune({
      cwd: dir, write: true, key: 'test-manifest-key', stageJson: stagerThatFailsToCommit(),
    });

    assert.equal(result.ok, false, 'the sweep failed and says so');
    assert.match(result.error, /rename exploded/);
    assert.match(result.error, /compensating manifest entry/);
    assert.equal(readFileSync(ticketsPath, 'utf8'), before, 'and the store really did not move');

    const entries = manifestEntries(dir);
    assert.equal(entries.length, 2, 'the attempt, then the correction');
    const [attempt, correction] = entries;
    assert.equal(attempt.data.action, 'apply');
    assert.notEqual(attempt.data.storeHashBefore, attempt.data.storeHashAfter,
      'the attempt claims a transition');

    assert.equal(correction.data.action, 'abandoned', 'the correction is marked as one');
    assert.equal(correction.data.bypass, true);
    assert.deepEqual(correction.data.ticketIds, ['RAILLESS'], 'and names the same tickets');
    assert.equal(correction.data.storeHashBefore, attempt.data.storeHashBefore,
      'it starts where the attempt started');
    assert.equal(correction.data.storeHashAfter, correction.data.storeHashBefore,
      'and says the store did not move — which is what actually happened');
    assert.ok(correction.sig, 'a correction is signed like any other entry, or it proves nothing');
  });
});

// Best effort has to be honest about its own failure. If the correction cannot be
// appended either, the false claim STANDS in the ledger — and the only place left
// to say so is the error the caller gets.
test('when the correction cannot be written either, the refusal says the ledger stands UNCORRECTED', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'RAILED', title: 'railed in-flight', scope: ['packages/never-built/**'], rails: ['src/guarded/**'] },
      { id: 'RAILLESS', title: 'shipped', scope: ['plugins/adlc-widget/**'], rails: [] },
    ]);
    const ticketsPath = join(dir, '.adlc', 'tickets.json');
    const before = readFileSync(ticketsPath, 'utf8');
    const manifestPath = join(dir, '.adlc', 'manifest.jsonl');

    const result = runTicketPrune({
      cwd: dir,
      write: true,
      key: 'test-manifest-key',
      // The rename fails AND the manifest stops being appendable — a directory
      // where the file goes, the same shape the audit-failure test below uses.
      stageJson: stagerThatFailsToCommit(() => {
        rmSync(manifestPath, { force: true });
        mkdirSync(manifestPath, { recursive: true });
      }),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /rename exploded/, 'the original failure is still reported');
    assert.match(result.error, /UNCORRECTED/, 'and so is the fact that the ledger is now wrong');
    assert.equal(readFileSync(ticketsPath, 'utf8'), before);
  });
});

// The correction only exists because an entry was written. On a rails-free store
// nothing was recorded, so there is nothing to correct — and a compensating entry
// would be the invention of evidence for a mutation that was never audited.
test('a rename failure on a rails-free store records nothing, because nothing was recorded', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'RAILLESS', title: 'shipped', scope: ['plugins/adlc-widget/**'], rails: [] },
    ]);
    const result = runTicketPrune({ cwd: dir, write: true, stageJson: stagerThatFailsToCommit() });

    assert.equal(result.ok, false);
    assert.match(result.error, /failed to write completions/);
    assert.doesNotMatch(result.error, /compensating|UNCORRECTED/,
      'no claim about a ledger this sweep never touched');
    assert.deepEqual(manifestEntries(dir), [], 'and the manifest was never created');
  });
});

// The audit and the store write cannot be one atomic act on this path, so the
// content is staged first and the entry appended before the rename. An audit that
// cannot be written must therefore leave NOTHING behind — not the mutation, and
// not the staged copy of it.
test('an audit that cannot be recorded refuses with tickets.json untouched and no staged leftovers', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'RAILED', title: 'railed in-flight', scope: ['packages/never-built/**'], rails: ['src/guarded/**'] },
      { id: 'RAILLESS', title: 'shipped', scope: ['plugins/adlc-widget/**'], rails: [] },
    ]);
    const ticketsPath = join(dir, '.adlc', 'tickets.json');
    const before = readFileSync(ticketsPath, 'utf8');
    // A manifest that cannot be appended to: a directory where the file goes.
    mkdirSync(join(dir, '.adlc', 'manifest.jsonl'), { recursive: true });

    const result = runTicketPrune({ cwd: dir, write: true, key: 'test-manifest-key' });

    assert.equal(result.ok, false);
    assert.match(result.error, /audit entry .* could not be recorded/);
    assert.equal(readFileSync(ticketsPath, 'utf8'), before, 'the mutation did not land');
    assert.deepEqual(
      readdirSync(join(dir, '.adlc')).filter((n) => n.startsWith('tickets.json.tmp')),
      [],
      'and the staged copy was cleaned up',
    );
  });
});

// Two stores making an identical tombstone are two mutations and must leave two
// records. This is the property a transition-derived id would break: identical
// content and identical hashes would collide, and the second store's change would
// be waved through as a retry of the first — unaudited.
test('two stores with identical content get distinct audit entries, not one shared retry', () => {
  withScratchRepo((dir) => {
    const tickets = [
      { id: 'RAILED', title: 'railed in-flight', scope: ['packages/never-built/**'], rails: ['src/guarded/**'] },
      { id: 'RAILLESS', title: 'shipped', scope: ['plugins/adlc-widget/**'], rails: [] },
    ];
    writeTickets(dir, tickets);
    const second = join(dir, 'second-store.json');
    writeFileSync(second, JSON.stringify({ tickets }, null, 2));

    const first = runTicketPrune({ cwd: dir, write: true, key: 'test-manifest-key' });
    assert.equal(first.ok, true, first.error);
    const other = runTicketPrune({ cwd: dir, ticketsPath: second, write: true, key: 'test-manifest-key' });
    assert.equal(other.ok, true, other.error);

    const entries = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.equal(entries.length, 2, 'one entry per store, not one shared between them');
    assert.equal(new Set(entries.map((e) => e.data.transactionId)).size, 2, 'and their ids differ');
    // Both stores really were tombstoned.
    assert.equal(readTickets(dir).tickets.find((t) => t.id === 'RAILLESS').completed, true);
    assert.equal(JSON.parse(readFileSync(second, 'utf8')).tickets.find((t) => t.id === 'RAILLESS').completed, true);
  });
});

test('a store with NO rails prunes exactly as before: no key needed, no manifest entry', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'RAILLESS', title: 'shipped', scope: ['plugins/adlc-widget/**'], rails: [] },
      { id: 'STILL-GOING', title: 'in flight', scope: ['packages/never-built/**'], rails: [] },
    ]);

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, true);
    assert.deepEqual(result.tombstoned.map((t) => t.id), ['RAILLESS']);
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'prune stays zero-ceremony off a trust root');
  });
});

test('#208: a preexisting-completed-field ticket is reported under needsCeremony and never rewritten', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], completed: false },
    ]);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, true);
    assert.deepEqual(result.needsCeremony.map((c) => c.id), ['T1']);
    assert.equal(result.needsCeremony[0].blocker, 'preexisting-completed-field');
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before); // completed:false stays
  });
});

test('#208: bin --ceremony exits 1 with the deprecation redirect and writes nothing', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], rails: ['test/x/**'] },
    ]);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');
    let code = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [BIN, '--ceremony', '--json'], { cwd: dir, encoding: 'utf8', env: process.env });
    } catch (err) {
      code = err.status ?? 1;
      stderr = err.stderr?.toString() ?? '';
    }
    assert.equal(code, 1);
    assert.match(stderr, /deprecated/);
    assert.match(stderr, /adlc ticket complete/);
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before);
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

function runBin(args, cwd, env = {}) {
  try {
    // stderr is captured on SUCCESS too: warnings (notably the unsigned-audit one)
    // are emitted by runs that exit 0, and a helper that only kept stderr on
    // failure made them unassertable.
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    if (result.status !== 0) return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

// The bin's own default for the opt-out. A default of ON would leave the library
// guard intact while the command every operator actually runs sailed past it.
test('bin: --write against a frozen trust root refuses without a key, and --allow-unsigned is the only way through', () => {
  withScratchRepo((dir) => {
    const tickets = [
      { id: 'RAILED', title: 'railed in-flight', scope: ['packages/never-built/**'], rails: ['src/guarded/**'] },
      { id: 'RAILLESS', title: 'shipped', scope: ['plugins/adlc-widget/**'], rails: [] },
    ];
    writeTickets(dir, tickets);
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    // ADLC_MANIFEST_KEY scrubbed explicitly: the bin resolves it from the
    // environment, and a developer who exports one would otherwise never see this
    // refusal locally while CI, which has none, hit it every time.
    const refused = runBin(['--write'], dir, { ADLC_MANIFEST_KEY: '' });
    assert.notEqual(refused.code, 0, 'an unsignable trust-root write is refused');
    assert.match(refused.stderr, /ADLC_MANIFEST_KEY/);
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before, 'and nothing was written');

    const allowed = runBin(['--write', '--allow-unsigned'], dir, { ADLC_MANIFEST_KEY: '' });
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(allowed.stderr, /unsigned/i, 'and going through unsigned says what it costs');
    assert.equal(readTickets(dir).tickets.find((t) => t.id === 'RAILLESS').completed, true);
  });
});

test('bin: --allow-unsigned WITH a key does not warn — the entry is signed either way', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'RAILED', title: 'railed in-flight', scope: ['packages/never-built/**'], rails: ['src/guarded/**'] },
      { id: 'RAILLESS', title: 'shipped', scope: ['plugins/adlc-widget/**'], rails: [] },
    ]);
    const { code, stderr } = runBin(['--write', '--allow-unsigned'], dir, { ADLC_MANIFEST_KEY: 'test-manifest-key' });
    assert.equal(code, 0, stderr);
    // Warning on a signed write teaches operators the warning is noise, which is
    // how the real one gets ignored.
    assert.doesNotMatch(stderr, /unsigned/i);
    assert.equal(readTickets(dir).tickets.find((t) => t.id === 'RAILLESS').completed, true);
  });
});

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

// ---- #208: directory backend respects the ceremony boundary under --write ----
//
// A prior version archived EVERY stale ticket on the directory store with
// authorized:true — including rail-freezing ones. Archiving removes a ticket from
// the active store, so that silently unfroze its rails without the per-ticket
// review the legacy path (and the contract) require. --write must archive only
// tombstone-eligible tickets and report the rest under needsCeremony.
import { ticketFilename } from '@adlc/tickets';

function writeDirectoryStore(dir, tickets) {
  const store = join(dir, '.adlc', 'tickets');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
  for (const t of tickets) writeFileSync(join(store, ticketFilename(t.id)), JSON.stringify(t));
}

test('#208: directory --write archives only rails-less stale tickets; a rail-freezing one is reported, not archived', () => {
  withScratchRepo((dir) => {
    // withScratchRepo seeds a legacy tickets.json; remove it and use a directory store.
    rmSync(join(dir, '.adlc', 'tickets.json'), { force: true });
    mkdirSync(join(dir, 'packages', 'util'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'util', 'b.mjs'), '// shipped\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'ship util'], dir);
    writeDirectoryStore(dir, [
      { id: 'RAILED', title: 'railed shipped', scope: ['plugins/adlc-widget/**'], rails: ['test/adlc-widget/**'] },
      { id: 'RAILLESS', title: 'rails-less shipped', scope: ['packages/util/**'] },
    ]);

    // RAILED declares a rail, so this store is a frozen trust root and archiving
    // out of it is an audited override that must be signable
    // (packages/tickets/test/bypass-audit.test.mjs). The key is incidental to
    // what this test asserts, which is WHICH tickets --write may archive.
    const result = runTicketPrune({ cwd: dir, write: true, key: 'test-manifest-key' });

    assert.equal(result.ok, true);
    assert.deepEqual((result.archived ?? []).map((a) => a?.id ?? a), ['RAILLESS']);
    assert.deepEqual((result.needsCeremony ?? []).map((e) => e.id), ['RAILED']);
    assert.equal(result.needsCeremony[0].blocker, 'rails-freeze');
    // The rail-freezing ticket's shard must still exist — its rails are intact.
    assert.ok(existsSync(join(dir, '.adlc', 'tickets', ticketFilename('RAILED'))),
      'rail-freezing ticket must NOT be archived by --write');
  });
});

// The opt-out was accepted by the CLI and then dropped one call short of
// archiveTicket, so it worked on the legacy backend and silently did not here.
test('the --allow-unsigned opt-out reaches the DIRECTORY backend too, not just the legacy one', () => {
  withScratchRepo((dir) => {
    rmSync(join(dir, '.adlc', 'tickets.json'), { force: true });
    writeDirectoryStore(dir, [
      { id: 'RAILED', title: 'railed in-flight', scope: ['packages/never-built/**'], rails: ['src/guarded/**'] },
      { id: 'RAILLESS', title: 'rails-less shipped', scope: ['plugins/adlc-widget/**'] },
    ]);

    // The directory branch reports a failed sweep rather than throwing, so
    // automation reading the result sees the refusal instead of an exit 0.
    const refused = runTicketPrune({ cwd: dir, write: true });
    assert.equal(refused.ok, false, 'keyless still refuses');
    assert.match(refused.error, /ADLC_MANIFEST_KEY/);
    assert.ok(existsSync(join(dir, '.adlc', 'tickets', ticketFilename('RAILLESS'))), 'nothing archived');

    const result = runTicketPrune({ cwd: dir, write: true, allowUnsigned: true });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual((result.archived ?? []).map((a) => a?.id ?? a), ['RAILLESS']);
  });
});

test('#208: directory --write does not archive a deliberately completed:false ticket', () => {
  withScratchRepo((dir) => {
    rmSync(join(dir, '.adlc', 'tickets.json'), { force: true });
    writeDirectoryStore(dir, [
      { id: 'KEEP', title: 'kept incomplete', scope: ['plugins/adlc-widget/**'], completed: false },
    ]);

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, true);
    assert.deepEqual((result.archived ?? []).map((a) => a?.id ?? a), []);
    assert.deepEqual((result.needsCeremony ?? []).map((e) => e.id), ['KEEP']);
    assert.equal(result.needsCeremony[0].blocker, 'preexisting-completed-field');
    assert.ok(existsSync(join(dir, '.adlc', 'tickets', ticketFilename('KEEP'))));
  });
});

test('#208: directory --write surfaces archived ids in the result (observability)', () => {
  withScratchRepo((dir) => {
    rmSync(join(dir, '.adlc', 'tickets.json'), { force: true });
    writeDirectoryStore(dir, [
      { id: 'RAILLESS', title: 'rails-less shipped', scope: ['plugins/adlc-widget/**'] },
    ]);
    const result = runTicketPrune({ cwd: dir, write: true });
    assert.equal(result.ok, true);
    // The mutation must be visible in both the result and the public formatters.
    assert.deepEqual((result.archived ?? []).map((a) => a?.id ?? a), ['RAILLESS']);
    assert.deepEqual(toJson(result).archived.map((a) => a?.id ?? a), ['RAILLESS']);
    assert.match(renderReport(result), /Archived 1 rails-less stale ticket\(s\) out of the active directory store:/);
  });
});

test('#208/T75: a directory batch with one inbound-edge-blocked ticket archives the rest and reports the blocked one (no mid-batch wedge)', () => {
  withScratchRepo((dir) => {
    rmSync(join(dir, '.adlc', 'tickets.json'), { force: true });
    // A and B are both rails-less shipped (archivable). B is referenced by active
    // ticket C via an edge, so archiveTicket rejects B with ARCHIVE_INBOUND_EDGE.
    // A archives; B is a genuine block (C stays active). The sweep must continue.
    mkdirSync(join(dir, 'packages', 'a2'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'a2', 'x.mjs'), '// a\n');
    mkdirSync(join(dir, 'packages', 'b2'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'b2', 'x.mjs'), '// b\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'ship a2 b2'], dir);
    writeDirectoryStore(dir, [
      { id: 'AAA', title: 'rails-less shipped', scope: ['packages/a2/**'] },
      { id: 'BBB', title: 'rails-less shipped', scope: ['packages/b2/**'] },
      { id: 'CCC', title: 'still building', scope: ['packages/never-built/**'], edges: [{ to: 'BBB', kind: 'depends' }] },
    ]);

    const result = runTicketPrune({ cwd: dir, write: true });

    // T75: the blocked ticket is a report, not a hard failure.
    assert.equal(result.ok, true);
    assert.deepEqual((result.archived ?? []).map((a) => a?.id ?? a), ['AAA']);
    assert.deepEqual((result.blocked ?? []).map((b) => b.id), ['BBB']);
    assert.match(result.blocked[0].error, /BBB|inbound|referenced|CCC/i);
  });
});

test('#208/T75: bin --write --json exits 0 and surfaces the blocked set on a partial sweep', () => {
  withScratchRepo((dir) => {
    rmSync(join(dir, '.adlc', 'tickets.json'), { force: true });
    mkdirSync(join(dir, 'packages', 'a3'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'a3', 'x.mjs'), '// a\n');
    mkdirSync(join(dir, 'packages', 'b3'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'b3', 'x.mjs'), '// b\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'ship a3 b3'], dir);
    writeDirectoryStore(dir, [
      { id: 'AAA', title: 'rails-less', scope: ['packages/a3/**'] },
      { id: 'BBB', title: 'rails-less', scope: ['packages/b3/**'] },
      { id: 'CCC', title: 'active', scope: ['packages/never-built/**'], edges: [{ to: 'BBB', kind: 'depends' }] },
    ]);
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [BIN, '--write', '--json'], { cwd: dir, encoding: 'utf8', env: process.env });
    } catch (err) {
      code = err.status ?? 1;
      out = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
    }
    // No hard failure: the archived one and the blocked one are both visible.
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.archived.map((a) => a?.id ?? a), ['AAA']);
    assert.deepEqual(parsed.blocked.map((b) => b.id), ['BBB']);
  });
});
