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

const SOURCE_EXTS = ['.mjs', '.js', '.cjs'];

/** List every source file under `dir`, skipping test/ and node_modules/ subtrees. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (SOURCE_EXTS.some((ext) => entry.name.endsWith(ext))) {
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
 * The path reference is matched two ways, so an idiomatic writer cannot evade:
 *   - BARE quoted form: `'.adlc/tickets.json'` (a gitignore negation
 *     `'!.adlc/tickets.json'` is NOT matched — the quote is followed by `!`), and
 *   - SEGMENTED construction: quoted `'tickets.json'` together with a quoted
 *     `'.adlc'` segment nearby, i.e. `join(x, '.adlc', 'tickets.json')` — the EXACT
 *     spelling the round-trip helpers themselves use.
 *
 * The write primitive set covers sync, promise, and callback forms:
 * writeJsonAtomic / writeTicketsAtomic / writeFileSync / renameSync / writeFile
 * (the bare `writeFile(` alt also catches `fs.promises.writeFile(`).
 *
 * Robustness to false positives: still gated on a `{ tickets }`-shaped envelope,
 * so a READER (`data.tickets.map(...)` — a `.` follows `tickets`) and a package
 * that only names the path in an ignore stanza (core/scaffold-hygiene.mjs) are
 * NOT writers.
 *
 * NOTE (see CONVENTIONS.md): this is a heuristic lexical tripwire for the common
 * in-repo spellings, NOT a proof of absence. A fully-indirected writer (path
 * assembled in a helper in another file, exotic serialization) can still slip
 * past a text scan; the round-trip PATTERN itself is the requirement, enforced by
 * review, with this gate catching the idiomatic cases.
 */
export function isTicketsWriterSource(src) {
  const callsDedicatedWriter = /writeTicketsAtomic\s*\(/.test(src);
  if (callsDedicatedWriter) return true;
  const bareTicketsPath = /['"`]\.adlc\/tickets\.json/.test(src);
  // Segmented construction must be ADJACENT (`'.adlc', 'tickets.json'` as
  // consecutive join args), NOT mere file-wide co-occurrence — otherwise a
  // package writing an UNRELATED `build/tickets.json` that merely mentions
  // `'.adlc'` elsewhere in the file would be falsely flagged (a drift-gate that
  // cries wolf gets disabled). Proximity is what makes it a `.adlc/tickets.json`
  // path, not two coincidental strings.
  const segmentedTicketsPath = /['"`]\.adlc['"`]\s*,\s*['"`]tickets\.json['"`]/.test(src);
  const referencesTicketsPath = bareTicketsPath || segmentedTicketsPath;
  // A `tickets` envelope key: `tickets:` (property) or `{ tickets }` / `{ tickets,`
  // (shorthand). The trailing [:,}] excludes a READER's `data.tickets.map(...)`
  // (a `.` follows `tickets`), so reads never masquerade as writes.
  const writesEnvelope =
    /\btickets\s*[:,}]/.test(src) &&
    /(?:writeJsonAtomic|writeTicketsAtomic|writeFileSync|renameSync|writeFile)\s*\(/.test(src);
  return referencesTicketsPath && writesEnvelope;
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

// Strip `//` line comments and `/* */` block comments so a COMMENTED mention of
// rails-guard-ci (e.g. `// rails-guard-ci`) can't be counted as real coverage.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * True iff the package owns a test that REALLY invokes scripts/rails-guard-ci.mjs.
 * The reference must be in CODE (comments are stripped first, so a bare
 * `// rails-guard-ci` no longer counts) AND the file must spawn a subprocess
 * (`execFileSync` / `spawnSync`) — the real round-trip tests bind a
 * `RAILS_GUARD_CI` path constant (which carries the `rails-guard-ci` string) and
 * spawn it. NOTE (heuristic tripwire, see CONVENTIONS.md): a contrived file with
 * a non-comment rails-guard-ci string AND an unrelated spawn is the residual
 * lexical limit; the round-trip PATTERN, enforced by review, is the requirement.
 */
export function packageHasRailsGuardRoundTrip(pkgDir) {
  const testDir = join(pkgDir, 'test');
  if (!existsSync(testDir) || !statSync(testDir).isDirectory()) return false;
  return readdirSync(testDir)
    .filter((f) => f.endsWith('.mjs'))
    .some((f) => {
      const src = stripComments(readFileSync(join(testDir, f), 'utf8'));
      return /rails-guard-ci/.test(src) && /(?:execFileSync|spawnSync)\s*\(/.test(src);
    });
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

// A SNEAKY writer that evades a bare-path scan: it assembles the tickets.json
// path from SEGMENTS via join(dir, '.adlc', 'tickets.json') — the exact idiom the
// round-trip helpers use — and writes the envelope with writeFileSync. If the
// detector only matched the bare '.adlc/tickets.json' string this would read GREEN.
const SNEAKY_SEGMENTED_WRITER_LIB = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function writeIt(dir, tickets) {
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2) + '\\n');
}
`;

// A writer using the promise form (fs.promises.writeFile) + segmented path.
const PROMISE_WRITER_LIB = `
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function writeIt(dir, tickets) {
  await writeFile(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }) + '\\n');
}
`;

const ROUND_TRIP_TEST = `import { execFileSync } from 'node:child_process';
// drives scripts/rails-guard-ci.mjs on real writer output
execFileSync('node', ['scripts/rails-guard-ci.mjs', 'main']);
`;

// A HOLLOW "test": it mentions rails-guard-ci in a comment but never spawns it.
// A string-only "covered" check would be fooled; a real-invocation check is not.
const COMMENT_ONLY_TEST = `// this file name-drops rails-guard-ci but does NOT run it
export const notReallyATest = 1;
`;

// A FALSE-POSITIVE probe for the segmented broadening: writes an UNRELATED
// build/tickets.json envelope AND has a QUOTED '.adlc' elsewhere (non-adjacent).
// A file-wide co-occurrence check (quoted 'tickets.json' + quoted '.adlc' anywhere)
// would WRONGLY flag it; the adjacency requirement must not.
const UNRELATED_BUILD_WRITER_LIB = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const IGNORED_DIRS = ['.adlc', 'node_modules'];
export function writeBuildManifest(tickets) {
  writeFileSync(join('build', 'tickets.json'), JSON.stringify({ tickets }));
}
`;

// A HOLLOW "covered" probe that's sneakier than COMMENT_ONLY: rails-guard-ci is
// mentioned ONLY in a comment, but the file ALSO has an UNRELATED subprocess spawn.
// A naive "rails-guard-ci AND spawn co-occur" check counts it as covered; stripping
// comments first must not (the rails-guard-ci mention vanishes with the comment).
const COMMENT_PLUS_UNRELATED_SPAWN_TEST = `import { execFileSync } from 'node:child_process';
// this comment name-drops rails-guard-ci but the spawn below is unrelated
execFileSync('git', ['status']);
export const notReallyATest = 1;
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

test('FIX 1 (evasion closed): flags a SEGMENTED-path writer — join(dir, ".adlc", "tickets.json") + writeFileSync', () => {
  // The #104-class hole the prosecutor found: a real writer using the exact
  // join-idiom the round-trip helpers use read GREEN under the old bare-string scan.
  assert.equal(isTicketsWriterSource(SNEAKY_SEGMENTED_WRITER_LIB), true);
});

test('FIX 1 (evasion closed): flags a PROMISE-form writer — fs.promises.writeFile + segmented path', () => {
  assert.equal(isTicketsWriterSource(PROMISE_WRITER_LIB), true);
});

test('FIX 1: a segmented "tickets.json" with NO .adlc segment is NOT a writer (avoids matching unrelated tickets.json files)', () => {
  const unrelated = `import { writeFileSync } from 'node:fs';
    // writes a DIFFERENT tickets.json (not under .adlc)
    writeFileSync('build/tickets.json', JSON.stringify({ tickets: [] }));`;
  assert.equal(isTicketsWriterSource(unrelated), false);
});

test('FIX 1 (no over-flag): a build/tickets.json writer that also has a QUOTED ".adlc" elsewhere (non-adjacent) is NOT a writer — proximity, not co-occurrence', () => {
  // Under the old file-wide co-occurrence check this read as a writer (quoted
  // 'tickets.json' + quoted '.adlc' both present); adjacency must reject it so the
  // drift-gate doesn't cry wolf on an unrelated build artifact.
  assert.equal(isTicketsWriterSource(UNRELATED_BUILD_WRITER_LIB), false);
});

// ── direction 1: the check CATCHES a planted uncovered writer ─────────────────

test('findUncoveredWriters FLAGS a planted writer package that has no rails-guard round-trip test', () => {
  withScratchPackages((packagesDir) => {
    mkPackage(packagesDir, 'rogue-writer', { libSrc: WRITER_LIB }); // writer, NO test
    const uncovered = findUncoveredWriters(packagesDir);
    assert.deepEqual(uncovered, ['rogue-writer'], 'a new tickets.json writer without a round-trip test must be flagged');
  });
});

test('FIX 1 end-to-end: findUncoveredWriters FLAGS a planted SEGMENTED-path writer with no round-trip test', () => {
  withScratchPackages((packagesDir) => {
    mkPackage(packagesDir, 'sneaky-writer', { libSrc: SNEAKY_SEGMENTED_WRITER_LIB }); // writer, NO test
    assert.deepEqual(findTicketsWriterPackages(packagesDir), ['sneaky-writer'], 'segmented-path writer must be detected');
    assert.deepEqual(findUncoveredWriters(packagesDir), ['sneaky-writer']);
  });
});

test('FIX 2 (hollow coverage closed): a writer whose only test MENTIONS rails-guard-ci in a comment (never spawns it) is still UNCOVERED', () => {
  withScratchPackages((packagesDir) => {
    mkPackage(packagesDir, 'fake-covered', { libSrc: WRITER_LIB, testSrc: COMMENT_ONLY_TEST });
    assert.deepEqual(
      findUncoveredWriters(packagesDir),
      ['fake-covered'],
      'a comment-only mention of rails-guard-ci must NOT count as coverage',
    );
  });
});

test('FIX 2 (residual closed): rails-guard-ci in a COMMENT plus an UNRELATED spawn is still UNCOVERED — comments are stripped before the check', () => {
  withScratchPackages((packagesDir) => {
    mkPackage(packagesDir, 'sneaky-covered', { libSrc: WRITER_LIB, testSrc: COMMENT_PLUS_UNRELATED_SPAWN_TEST });
    assert.deepEqual(
      findUncoveredWriters(packagesDir),
      ['sneaky-covered'],
      'a commented rails-guard-ci mention next to an unrelated spawn must NOT count as coverage',
    );
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
