// roundtrip-coverage.test.mjs — the drift gate for the producer→consumer
// round-trip pattern (T40 / #104).
//
// #104 was a producer/consumer contract mismatch: `ticket-prune` (producer)
// wrote a `.adlc/tickets.json` diff that `scripts/rails-guard-ci.mjs` (consumer
// gate) then DENIED, and no test exercised the seam. The fix is the round-trip
// tests; THIS test keeps the pattern from silently rotting: any package that
// WRITES `.adlc/tickets.json` must own a test that runs its real output through
// the real `rails-guard-ci.mjs`.
//
// It is a static, deterministic, offline scan (no subprocesses, no network):
//   - findTicketsWriterPackages(packagesDir) → packages whose lib/bin genuinely
//     write the tickets.json envelope (robust to false positives — a package that
//     only NAMES the path, e.g. in a .gitignore stanza, is NOT a writer).
//   - packageHasRailsGuardRoundTrip(pkgDir) → the package has a test that invokes
//     scripts/rails-guard-ci.mjs.
//   - findUncoveredWriters(packagesDir) → writers missing that test (the drift).
//
// Proven BOTH ways: it FLAGS a planted writer-with-no-round-trip fixture, does
// NOT flag a planted false-positive (path-naming-only) package, and PASSES for
// the real packages/ tree (ticket-prune + ticket-sync now have round-trips).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_PACKAGES = join(REPO_ROOT, 'packages');

// ── the detector (pure; exercised on both the real tree and temp fixtures) ────

/** List every *.mjs under `dir`, skipping test/ and node_modules/ subtrees. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (entry.name.endsWith('.mjs')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * True iff `src` GENUINELY writes the `.adlc/tickets.json` envelope — not merely
 * references the path string. Two independent positive signals:
 *   1. It calls a tickets-dedicated atomic writer (`writeTicketsAtomic(...)`), or
 *   2. it references the tickets.json path as a real file location AND serializes
 *      a `{ tickets: ... }` envelope through a write/rename primitive.
 *
 * Robustness to false positives: the path is matched only in its BARE quoted form
 * (`'.adlc/tickets.json'`), so a gitignore negation (`'!.adlc/tickets.json'`) —
 * the quote is followed by `!`, not `.` — never counts. A package that only names
 * the path in an ignore stanza (e.g. core/scaffold-hygiene.mjs) is NOT a writer.
 */
export function isTicketsWriterSource(src) {
  const callsDedicatedWriter = /writeTicketsAtomic\s*\(/.test(src);
  if (callsDedicatedWriter) return true;
  const referencesBareTicketsPath = /['"`]\.adlc\/tickets\.json/.test(src);
  // A `tickets` envelope key: `tickets:` (property) or `{ tickets }` / `{ tickets,`
  // (shorthand). The trailing [:,}] excludes a READER's `data.tickets.map(...)`
  // (a `.` follows `tickets`), so reads never masquerade as writes.
  const writesEnvelope =
    /\btickets\s*[:,}]/.test(src) &&
    /(?:writeJsonAtomic|writeFileSync|renameSync|writeTicketsAtomic)\s*\(/.test(src);
  return referencesBareTicketsPath && writesEnvelope;
}

/** Names of packages under `packagesDir` that write `.adlc/tickets.json`. */
export function findTicketsWriterPackages(packagesDir) {
  const writers = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(packagesDir, entry.name);
    const isWriter = sourceFiles(pkgDir).some((f) => isTicketsWriterSource(readFileSync(f, 'utf8')));
    if (isWriter) writers.push(entry.name);
  }
  return writers.sort();
}

/** True iff the package owns a test that invokes scripts/rails-guard-ci.mjs. */
export function packageHasRailsGuardRoundTrip(pkgDir) {
  const testDir = join(pkgDir, 'test');
  if (!existsSync(testDir) || !statSync(testDir).isDirectory()) return false;
  return readdirSync(testDir)
    .filter((f) => f.endsWith('.mjs'))
    .some((f) => /rails-guard-ci/.test(readFileSync(join(testDir, f), 'utf8')));
}

/** Writer packages that lack a rails-guard-ci round-trip test (the drift). */
export function findUncoveredWriters(packagesDir) {
  return findTicketsWriterPackages(packagesDir).filter(
    (name) => !packageHasRailsGuardRoundTrip(join(packagesDir, name)),
  );
}

// ── fixtures: a scratch packages/ tree we can plant writers into ──────────────

function mkPackage(packagesDir, name, { libSrc, testSrc } = {}) {
  const pkgDir = join(packagesDir, name);
  mkdirSync(join(pkgDir, 'lib'), { recursive: true });
  if (libSrc !== undefined) writeFileSync(join(pkgDir, 'lib', 'run.mjs'), libSrc);
  if (testSrc !== undefined) {
    mkdirSync(join(pkgDir, 'test'), { recursive: true });
    writeFileSync(join(pkgDir, 'test', 'roundtrip.test.mjs'), testSrc);
  }
  return pkgDir;
}

// A genuine tickets.json writer body (mirrors ticket-prune/ticket-sync shape).
const WRITER_LIB = `
import { writeFileSync, renameSync } from 'node:fs';
const TICKETS = '.adlc/tickets.json';
export function writeIt(dir, tickets) {
  const tmp = TICKETS + '.tmp';
  writeFileSync(tmp, JSON.stringify({ tickets }, null, 2) + '\\n');
  renameSync(tmp, TICKETS);
}
`;

// A false-positive body: names the tickets.json path ONLY as a gitignore
// negation stanza (exactly core/scaffold-hygiene.mjs's shape) and writes .gitignore.
const NON_WRITER_LIB = `
import { writeFileSync } from 'node:fs';
const GITIGNORE_STANZA = ['.adlc/*', '!.adlc/tickets.json', '!.adlc/specs/'];
export function ensureGitignore(path) {
  writeFileSync(path, GITIGNORE_STANZA.join('\\n') + '\\n');
}
`;

const ROUND_TRIP_TEST = `import { execFileSync } from 'node:child_process';
// drives scripts/rails-guard-ci.mjs on real writer output
execFileSync('node', ['scripts/rails-guard-ci.mjs', 'main']);
`;

function withScratchPackages(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-coverage-'));
  try {
    mkdirSync(join(dir, 'packages'));
    return fn(join(dir, 'packages'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the pure-detector unit contract (documents the both-ways behavior) ────────

test('isTicketsWriterSource: flags a genuine { tickets } envelope writer', () => {
  assert.equal(isTicketsWriterSource(WRITER_LIB), true);
});

test('isTicketsWriterSource: does NOT flag a package that only names the path in a gitignore stanza (no false positive)', () => {
  assert.equal(isTicketsWriterSource(NON_WRITER_LIB), false);
});

test('isTicketsWriterSource: does NOT flag a tickets.json READER (reads, never writes an envelope)', () => {
  const reader = `import { readFileSync } from 'node:fs';
    const d = JSON.parse(readFileSync('.adlc/tickets.json', 'utf8'));
    export const ids = d.tickets.map((t) => t.id);`;
  assert.equal(isTicketsWriterSource(reader), false);
});

// ── direction 1: the check CATCHES a planted uncovered writer ─────────────────

test('findUncoveredWriters FLAGS a planted writer package that has no rails-guard round-trip test', () => {
  withScratchPackages((packagesDir) => {
    mkPackage(packagesDir, 'rogue-writer', { libSrc: WRITER_LIB }); // writer, NO test
    const uncovered = findUncoveredWriters(packagesDir);
    assert.deepEqual(uncovered, ['rogue-writer'], 'a new tickets.json writer without a round-trip test must be flagged');
  });
});

// ── direction 2: the check PASSES once the writer gains a round-trip test ──────

test('findUncoveredWriters does NOT flag a writer once it owns a rails-guard-ci round-trip test', () => {
  withScratchPackages((packagesDir) => {
    mkPackage(packagesDir, 'good-writer', { libSrc: WRITER_LIB, testSrc: ROUND_TRIP_TEST });
    assert.deepEqual(findUncoveredWriters(packagesDir), []);
  });
});

// ── robustness: a false-positive package is neither a writer nor flagged ───────

test('findUncoveredWriters ignores a false-positive (path-naming-only) package even with no round-trip test', () => {
  withScratchPackages((packagesDir) => {
    mkPackage(packagesDir, 'not-a-writer', { libSrc: NON_WRITER_LIB }); // names path, never writes envelope
    assert.deepEqual(findTicketsWriterPackages(packagesDir), [], 'must not be treated as a writer');
    assert.deepEqual(findUncoveredWriters(packagesDir), [], 'and therefore must not be flagged');
  });
});

test('a writer AND a false-positive together: only the real writer is flagged when uncovered', () => {
  withScratchPackages((packagesDir) => {
    mkPackage(packagesDir, 'rogue-writer', { libSrc: WRITER_LIB });
    mkPackage(packagesDir, 'not-a-writer', { libSrc: NON_WRITER_LIB });
    assert.deepEqual(findUncoveredWriters(packagesDir), ['rogue-writer']);
  });
});

// ── the real tree: the two known writers exist AND are covered ────────────────

test('the REAL packages/ tree has exactly the expected tickets.json writers', () => {
  const writers = findTicketsWriterPackages(REAL_PACKAGES);
  assert.ok(writers.includes('ticket-prune'), `ticket-prune must be detected as a writer; got ${writers.join(', ')}`);
  assert.ok(writers.includes('ticket-sync'), `ticket-sync must be detected as a writer; got ${writers.join(', ')}`);
});

test('the REAL packages/ tree has NO uncovered tickets.json writer (every writer owns a rails-guard round-trip test)', () => {
  const uncovered = findUncoveredWriters(REAL_PACKAGES);
  assert.deepEqual(
    uncovered,
    [],
    `these packages write .adlc/tickets.json but have no test invoking scripts/rails-guard-ci.mjs: ${uncovered.join(', ')}`,
  );
});
