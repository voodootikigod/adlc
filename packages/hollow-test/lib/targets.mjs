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
// ── comment-only change detection (#1032) ──────────────────────────────────
//
// #658 makes hollow-test fail closed when a diff-derived file yields zero
// mutants. Right for a real code change no operator can see; wrong for a diff
// that changed only comments, where there is no behaviour to mutate at all.
//
// The entire design is biased one way. Calling a comment "code" costs a
// needless fail-closed. Calling code "a comment" SILENTLY SKIPS an unverified
// change — the vacuous-pass class #70/#41/#35/#658 exist to close, and the
// failure this file already warns about: "a coverage gate that reports green by
// not looking is worse than no gate."
//
// So a line is a comment only when TWO INDEPENDENT PASSES AGREE:
//
//   1. a stateful scan of the whole file, which is the only thing that can see
//      that a `// ...` line sitting inside a multi-line template literal is
//      string DATA rather than a comment, and
//   2. a purely lexical per-line rule that knows nothing about state.
//
// Requiring agreement is what makes the mistakes safe in BOTH directions, and
// it is not theoretical. `packages/context-handoff/lib/adapter.mjs` contains
// `/(?:[^\s;|&`'"()]*[/\\])?.../` — a regex whose character class holds a
// backtick. A scanner without regex handling reads that backtick as opening a
// template, and ~500 lines later a backtick inside a comment closes it, leaving
// a `/*` inside the prose `` `.adlc/*` `` to open a SPURIOUS BLOCK COMMENT.
// Every real code line after that reads as comment text. Pass 2 disagrees on
// each of them, so they stay code.

/** Characters after which a `/` begins a regex literal rather than a division. */
const REGEX_MAY_FOLLOW = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*',
  '%', '~', '^', '<', '>', '\n',
]);

/**
 * Pass 1 — stateful scan. Returns the 1-based line numbers bearing at least one
 * character of PROGRAM (as opposed to comment), plus whether the scan can be
 * trusted at all.
 *
 * `trustworthy` is false when the file ends mid-block-comment, mid-template or
 * mid-string, or a regex literal never closes: the scan has lost its place, and
 * every caller must fall back to treating the file as code.
 */
function scanCodeBearingLines(source) {
  const lines = String(source).split('\n');
  const codeBearing = new Set();
  let state = 'code';
  let lastSignificant = '\n';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    // A line that OPENS inside a template is string content before any
    // character is read — including a blank one, since whitespace inside a
    // template is part of the value it produces.
    if (state === 'template') codeBearing.add(lineNo);

    let j = 0;
    while (j < line.length) {
      const ch = line[j];
      const next = line[j + 1];

      if (state === 'block') {
        if (ch === '*' && next === '/') { state = 'code'; j += 2; continue; }
        j++;
        continue;
      }

      if (state === 'template') {
        codeBearing.add(lineNo);
        if (ch === '\\') { j += 2; continue; }
        if (ch === '`') { state = 'code'; lastSignificant = '`'; j++; continue; }
        j++;
        continue;
      }

      // state === 'code'
      if (ch === ' ' || ch === '\t' || ch === '\r') { j++; continue; }
      if (ch === '/' && next === '/') { j = line.length; continue; }
      if (ch === '/' && next === '*') { state = 'block'; j += 2; continue; }

      codeBearing.add(lineNo);

      if (ch === '/' && REGEX_MAY_FOLLOW.has(lastSignificant)) {
        // A regex literal. Consume it whole so a backtick or quote inside it —
        // `[^\s;|&`'"()]` is a real example in this repo — cannot be mistaken
        // for the start of a template or string. Character classes are tracked
        // because `/` inside `[...]` does not terminate the literal.
        j++;
        let inClass = false;
        let closed = false;
        while (j < line.length) {
          const c = line[j];
          if (c === '\\') { j += 2; continue; }
          if (inClass) { if (c === ']') inClass = false; j++; continue; }
          if (c === '[') { inClass = true; j++; continue; }
          if (c === '/') { closed = true; j++; break; }
          j++;
        }
        // Regex literals cannot span lines, so an unclosed one means the
        // "is this a regex" guess was wrong and the scan is off the rails.
        if (!closed) return { codeBearing, lineCount: lines.length, trustworthy: false };
        lastSignificant = '/';
        continue;
      }

      if (ch === '`') { state = 'template'; lastSignificant = '`'; j++; continue; }

      if (ch === "'" || ch === '"') {
        j++;
        let closed = false;
        while (j < line.length) {
          if (line[j] === '\\') { j += 2; continue; }
          if (line[j] === ch) { closed = true; j++; break; }
          j++;
        }
        if (!closed) return { codeBearing, lineCount: lines.length, trustworthy: false };
        lastSignificant = ch;
        continue;
      }

      lastSignificant = ch;
      j++;
    }
  }

  return { codeBearing, lineCount: lines.length, trustworthy: state === 'code' };
}

/**
 * Pass 2 — stateless lexical rule. A line is comment-shaped when it is blank,
 * starts with `//`, or lies inside a block that OPENS on a line whose first
 * non-whitespace characters are `/*`.
 *
 * Deliberately ignorant of strings and templates: that ignorance is the point,
 * because it cannot inherit a corrupted state from earlier in the file. A line
 * that closes a block and then carries code is code, which is also how
 * `/* closed *​/ const limit = 3;` stays mutable (mutate.mjs, #372 defect 4).
 */
function lexicalCommentLines(source) {
  const lines = String(source).split('\n');
  const commentShaped = new Set();
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();

    if (inBlock) {
      const closeAt = line.indexOf('*/');
      if (closeAt === -1) { commentShaped.add(lineNo); continue; }
      inBlock = false;
      if (line.slice(closeAt + 2).trim() === '') commentShaped.add(lineNo);
      continue;
    }

    if (trimmed === '' || trimmed.startsWith('//')) { commentShaped.add(lineNo); continue; }

    if (trimmed.startsWith('/*')) {
      const closeAt = line.indexOf('*/');
      if (closeAt === -1) { commentShaped.add(lineNo); inBlock = true; continue; }
      if (line.slice(closeAt + 2).trim() === '') commentShaped.add(lineNo);
    }
  }

  return commentShaped;
}

/**
 * True only when EVERY changed line is provably comment text or blank (#1032).
 *
 * False on any doubt: an untrustworthy scan, a line number outside the file, a
 * line the two passes disagree about, or an empty change set (nothing changed
 * means this predicate has no opinion, and a caller must not read that as
 * permission to skip). An `import`, `export` or `console.log` line is CODE here
 * even though no mutation operator can see it — that is a different cause
 * (#1031) and must keep failing closed.
 *
 * @param {string} source            current file content
 * @param {Iterable<number>} changed 1-based changed line numbers
 */
export function changedLinesAreCommentOnly(source, changed) {
  const numbers = [...(changed ?? [])];
  if (numbers.length === 0) return false;

  const { codeBearing, lineCount, trustworthy } = scanCodeBearingLines(source);
  if (!trustworthy) return false;

  const commentShaped = lexicalCommentLines(source);

  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1 || n > lineCount) return false;
    if (codeBearing.has(n)) return false;
    if (!commentShaped.has(n)) return false;
  }
  return true;
}

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
