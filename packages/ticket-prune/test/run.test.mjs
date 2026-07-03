import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTicketPrune } from '../lib/run.mjs';

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
function withScratchRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-prune-run-'));
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
