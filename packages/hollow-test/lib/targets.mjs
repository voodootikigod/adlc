// hollow-test/lib/targets.mjs
// Filters diff targets, distributing the mutation budget across files.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globMatch } from '@adlc/core';

// SOURCE IS AN INCLUDE-LIST, NOT AN EXCLUDE-LIST, AND THIS IS THE ONLY COPY.
//
// This was `EXCLUDE_EXT_RE = /\.(?:md|json|yml|yaml|lock|txt|toml|snap)$/`,
// applied as an exclusion. That answers the wrong question — "is this one of the
// non-source extensions I happened to think of?" — so anything with NO extension
// matched nothing and fell through as mutable code: CODEOWNERS, LICENSE,
// Dockerfile, Makefile, .gitignore, .nvmrc. An exclusion list is unbounded by
// construction: every extensionless file anyone adds later is a fresh false
// positive, each discovered the same expensive way, as a red required gate on an
// unrelated PR.
//
// The predicate is EXPORTED and shared with scripts/mutation-gate.mjs, which
// previously kept its own copy of the same regex. The two drifted, and drift here
// is silent in the dangerous direction: if the wrapper decides a file is not
// source, hollow-test is never invoked for it at all, so the required coverage
// gate goes green without testing the change. A TypeScript-only diff did exactly
// that. One predicate, one contract, asserted by a cross-contract test.
// The test exclusion needs BOUNDARIES. It was `/(?:test|spec)/i` — a substring
// match over the whole path — so any production file whose path merely contained
// those letters was classified as non-source and silently never mutated. Eleven
// tracked files at the time this was found, including the entire hollow-test
// package (this one — the mutation tool exempting itself from mutation), the
// entire spec-lint package, and gate-manifest's attestation module:
//
//   packages/hollow-test/lib/targets.mjs     "hollow-test"
//   packages/gate-manifest/lib/attest.mjs    "attest"
//   packages/spec-lint/lib/parse.mjs         "spec-lint"
//   scripts/run-tests.mjs                    "run-tests"
//   apps/.../latest/...                      "latest"
//
// A coverage gate that reports green by not looking is worse than no gate, and
// this one hid itself: the predicate defining what gets mutated was exempt from
// the gate that uses it. Match a whole path SEGMENT, or a `.test.`/`.spec.`
// filename, and nothing else.
const EXCLUDE_DIR_RE = /(?:^|\/)(?:tests?|specs?|__tests__)\//i;
// Filename conventions, anchored to the BASENAME, matching `node --test`'s OWN
// default discovery: `test.js`, `test-*`, `*-test`, `*_test`, `*.test.*` (and
// the spec equivalents). An earlier revision excluded only the dotted, exact and
// snake forms on the theory that hyphens were a stylistic choice; they are not —
// they are Node's documented convention, and this tool's own examples use
// `node --test`. Admitting them meant a test-only diff got its ASSERTIONS
// mutated: flipping `true` to `false` makes the changed test fail, which is
// credited as a killed production mutant, so the gate passes having mutated no
// production code at all.
//
// This does catch product names that merely look like tests — `hollow-test.mjs`
// and `spec-lint.mjs` are production source in this very repository. That is
// what `sourceGlobs` is for: an explicit override, rather than a heuristic
// guessing which side of the ambiguity a given project is on.
const EXCLUDE_FILE_RE =
  /(?:^|\/)(?:[^/]*\.(?:test|spec)\.[^/]+|(?:test|spec)\.[^/.]+|(?:test|spec)[-_][^/]+|[^/]*[-_](?:test|spec)\.[^/.]+)$/i;

const SOURCE_EXT_RE = /\.(?:mjs|cjs|js)$/i;

/**
 * True when a path is source this tool can mutate. The single definition of
 * "source" for both hollow-test and the mutation-gate wrapper.
 * @param {string} file repo-relative path
 */
/**
 * Extension check ONLY — is this a language whose operators we implement?
 *
 * Split out from isMutableSource because explicit --target/--rails paths
 * DELIBERATELY bypass test-path exclusion (rails ARE test files; that is the
 * whole point of the P3 rails-authoring workflow). They must still not be
 * mutated in an unsupported language, so they need the language half of the
 * predicate without the test-discovery half. Conflating the two rejected every
 * rail under a test/ directory and broke the documented workflow.
 * @param {string} file repo-relative path
 */
export function isSupportedSourceExtension(file) {
  return SOURCE_EXT_RE.test(file);
}

export function isMutableSource(file, { testGlobs = [], sourceGlobs = [] } = {}) {
  // Explicit source declaration wins over every heuristic below. Names like
  // `hollow-test.mjs` are indistinguishable from a test by convention alone, so
  // the only correct answer is to let the project say which it is.
  if (sourceGlobs.some((g) => globMatch(g, file))) {
    return SOURCE_EXT_RE.test(file);
  }
  if (EXCLUDE_DIR_RE.test(file)) return false;
  if (EXCLUDE_FILE_RE.test(file)) return false;
  // Caller-declared test paths. The built-in rules cannot infer every project's
  // convention, and the hyphenated forms in particular are genuinely ambiguous
  // (see EXCLUDE_FILE_RE). Rather than guess wrong in either direction, a
  // consumer whose tests are named `foo-test.js` declares it:
  //   hollow-test --test-glob '**/*-test.js'
  if (testGlobs.some((g) => globMatch(g, file))) return false;
  return SOURCE_EXT_RE.test(file);
}

/**
 * Determine which files from the diff should be mutated.
 * Excludes test/spec files and non-code files.
 *
 * @param {{ [file: string]: Set<number> }} changedLines - From mutate.changedLinesFromDiff()
 * @returns {string[]} Array of file paths eligible for mutation.
 */
export function filterTargetFiles(changedLines, { testGlobs = [], sourceGlobs = [] } = {}) {
  return Object.keys(changedLines).filter((f) => isMutableSource(f, { testGlobs, sourceGlobs }));
}

/**
 * Distribute a total mutation budget across files in round-robin fashion.
 * Returns an array of { file, targetLines, quota } objects.
 *
 * `priorityFiles` (e.g. explicit --target/--rails files) are guaranteed at
 * least 1 mutant of quota each — reserved off the top of `maxTotal` — before
 * the remainder is distributed round-robin across ALL files. Without this,
 * plain round-robin-by-index starves an explicitly-named target to quota 0
 * whenever diff-derived files alone consume the whole budget (the file the
 * caller most wants mutated — the whole point of --target/--rails — would
 * silently never be touched). See issues #70/#41/#35.
 *
 * @param {string[]} files          - Filtered file paths.
 * @param {{ [file: string]: Set<number> }} changedLines
 * @param {number} maxTotal         - Total mutant budget.
 * @param {string} cwd              - Repository root (to resolve relative paths).
 * @param {string[]} [priorityFiles] - Files to guarantee a minimum quota of 1
 *                                     (subject to maxTotal), before the
 *                                     remaining budget is split round-robin.
 * @returns {Array<{ file: string, absolutePath: string, targetLines: Set<number>, quota: number }>}
 */
export function buildFileTargets(files, changedLines, maxTotal, cwd, priorityFiles = []) {
  if (files.length === 0) return [];

  const prioritySet = new Set(priorityFiles);
  // Preserves `files` order — first `reserved` priority files (by that
  // order) get a guaranteed slot; if maxTotal is smaller than the number of
  // priority files, the rest legitimately can't be guaranteed (the caller
  // is told to raise --max — see hollow-test.mjs's post-build check).
  const priorityInFiles = files.filter((f) => prioritySet.has(f));
  const reserved = Math.min(priorityInFiles.length, maxTotal);
  const remaining = maxTotal - reserved;

  const reservedQuota = new Map();
  priorityInFiles.forEach((f, i) => reservedQuota.set(f, i < reserved ? 1 : 0));

  const base = Math.floor(remaining / files.length);
  const remainder = remaining % files.length;

  return files.map((file, idx) => ({
    file,
    absolutePath: resolve(cwd, file),
    targetLines: changedLines[file],
    quota: (reservedQuota.get(file) ?? 0) + base + (idx < remainder ? 1 : 0),
  }));
}

/**
 * Read file content from disk. Returns null if the file cannot be read.
 *
 * @param {string} absolutePath
 * @returns {string | null}
 */
export function readFileSafe(absolutePath) {
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

// ── explicit --target / --rails support (issues #70, #41, #35B) ────────────
// filterTargetFiles()/buildFileTargets() above are strictly diff-scoped. The
// functions below let a caller declare mutation targets independent of the
// diff — the P3 rails-authoring and characterization-test ticket shapes have
// nothing (or nothing relevant) in the diff to mutate otherwise.

/**
 * Read the `rails` glob array declared in a ticket file. Accepts either:
 *  - a single-ticket JSON object: `{ "rails": [...], ... }`
 *  - a full tickets.json-shaped file: `{ "tickets": [ { "rails": [...] }, … ] }`
 *    — rails from every ticket in the file are merged (deduplicated).
 *
 * @param {string} absolutePath
 * @returns {string[]} declared rail globs (empty array if none declared)
 * @throws {Error} if the file cannot be read or is not valid JSON
 */
export function readRailsFromTicketFile(absolutePath) {
  let raw;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${absolutePath}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${absolutePath}: ${err.message}`);
  }
  const rails = [];
  if (Array.isArray(data.rails)) rails.push(...data.rails);
  if (Array.isArray(data.tickets)) {
    for (const t of data.tickets) {
      if (t && Array.isArray(t.rails)) rails.push(...t.rails);
    }
  }
  return [...new Set(rails)];
}

/**
 * Expand a list of rail glob patterns to concrete repo-relative file paths,
 * matched against a candidate file list (e.g. `git ls-files` output).
 *
 * @param {string[]} rails - glob patterns
 * @param {string[]} allFiles - repo-relative candidate paths
 * @returns {string[]} matching file paths, deduplicated, in allFiles order
 */
export function expandRailsToFiles(rails, allFiles) {
  if (!rails || rails.length === 0) return [];
  return allFiles.filter((file) => rails.some((glob) => globMatch(glob, file)));
}
