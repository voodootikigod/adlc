#!/usr/bin/env node
// rails-guard — C5 rail-freeze enforcement + suppression-marker gate.
// Thin CLI: parse args, call lib, exit with correct code.

import {
  parseArgs,
  opError,
  printJson,
  isGitRepo,
  gitDiff,
  changedFiles as coreChangedFiles,
  loadTickets,
  hashFiles,
  git,
  globMatch,
  resolveBase,
  ADLC_DIR,
} from '@adlc/core';
import { appendManifestEntry } from '@adlc/gate-manifest';

import { readFileSync, lstatSync } from 'node:fs';

import { runChecks } from '../lib/check.mjs';
import { formatViolations, buildResult } from '../lib/output.mjs';
import { computeFencedLines, isMdxFile } from '../lib/suppressions.mjs';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';

const { values } = parseArgs({
  options: {
    base:    { type: 'string'  },
    ticket:  { type: 'string'  },
    tickets: { type: 'string'  },
    rails:   { type: 'string',  multiple: true },
    record:  { type: 'boolean', default: false },
    json:    { type: 'boolean', default: false },
    help:    { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`rails-guard [--base <ref>] [--ticket <id>] [--tickets <path>] [--rails <glob>...] [--record] [--json]

Rail-freeze enforcement + suppression-marker gate (ADLC C5).

  --base <ref>       Git ref to diff against. When omitted, the freeze baseline is
                     resolved to the merge-base of HEAD with trunk (main/master/
                     origin/main/origin/master). If no trunk ref is found, the
                     gate fails closed — pass --base explicitly. NEVER defaults to
                     HEAD, which would hide already-committed rail edits.
  --ticket <id>      Ticket ID to load rails and allow-suppression declarations from
  --tickets <path>   Path to tickets.json (default: .adlc/tickets.json)
  --rails <glob>     One or more glob patterns declaring frozen rail paths
                     (repeatable; overrides ticket.rails)
  --record           On a clean pass, append a manifest entry to .adlc/manifest.jsonl
  --json             Machine-readable JSON output
  --help             Show this help

Exit codes:
  0  Gate passes (no violations)
  1  Operational error (not a git repo, bad input, no rails resolvable)
  2  Gate fails (violations found)
`);
  process.exit(0);
}

// --- git check ---
if (!isGitRepo()) {
  opError('not inside a git repository');
}

// --- load ticket if requested ---
let ticket = null;
if (values.ticket) {
  const ticketsPath = values.tickets ?? `${ADLC_DIR}/tickets.json`;
  const { tickets, errors } = loadTickets(ticketsPath);
  if (errors.length > 0 && tickets.length === 0) {
    opError(`could not load tickets from ${ticketsPath}: ${errors[0]}`);
  }
  ticket = tickets.find((t) => t.id === values.ticket) ?? null;
  if (!ticket) {
    opError(`ticket "${values.ticket}" not found in ${ticketsPath}`);
  }
}

// --- resolve rail globs early to catch missing-rails before doing git work ---
const cliRails = values.rails ?? [];
if (cliRails.length === 0 && !ticket) {
  opError('no --rails supplied and no --ticket given — cannot determine rail globs');
}

if (cliRails.length === 0 && ticket && (ticket.rails ?? []).length === 0) {
  opError(`ticket ${ticket.id} has no rails declared and no --rails flag supplied`);
}

// --- resolve freeze baseline ---
// Honor an explicit --base. Otherwise resolve the merge-base with trunk; NEVER
// fall back to 'HEAD' — `git diff HEAD` only shows working-tree changes, so a
// builder who COMMITS a rail edit would leave a clean tree and forge a pass.
let base = values.base;
if (base === undefined) {
  base = resolveBase();
  if (base === null) {
    opError(
      'could not resolve a freeze baseline: no trunk ref (main/master/origin/main/' +
      'origin/master) found. Pass --base <ref> explicitly. Refusing to default to ' +
      'HEAD, which would hide already-committed rail edits.'
    );
  }
}

// --- git work ---
let diff;
let files;
try {
  diff  = gitDiff(base);
  files = coreChangedFiles(base);
} catch (err) {
  opError(`git error: ${err.message}`);
}

// --- authoritative `.mdx` fenced-code lookup ---
// Compute fenced-block membership from the FULL working-tree file (HEAD content is
// exactly what MDX compiles), memoized per file. Fails CLOSED: any file that cannot
// be read yields an empty set, so its markers are scanned rather than skipped.
const fenceCache = new Map();
function isFenced(file, lineNo) {
  if (!isMdxFile(file)) return false;
  let fenced = fenceCache.get(file);
  if (fenced === undefined) {
    try {
      fenced = computeFencedLines(readFileSync(file, 'utf8'));
    } catch {
      fenced = new Set(); // unreadable → fail closed (scan every line)
    }
    fenceCache.set(file, fenced);
  }
  return fenced.has(lineNo);
}

// --- manifest revision accessor for the #228 version-only exemption ---
// `before` is the freeze baseline blob; `after` is the working tree, which is what
// `git diff <base>` compared against. Any failure — file absent at base, deleted at
// HEAD, unreadable — returns null and the edit stays a violation (fails closed).
const contentCache = new Map();
function resolveContents(file) {
  if (contentCache.has(file)) return contentCache.get(file);
  let contents = null;
  try {
    // A FILENAME IS NOT A PATHSPEC. `changedFiles` returns raw paths, but
    // `ls-tree` takes a PATHSPEC, and git reads a leading `:(...)` as pathspec
    // MAGIC. A file literally named `:(top)victim/package.json` made `ls-tree`
    // report the mode of a completely different path, so a symlink passed the
    // mode check. `--literal-pathspecs` on that call is the fix.
    //
    // A second guard refusing any leading `:` was tried and REMOVED: it and the
    // literal flag shadowed each other, so no test could pin either one. One
    // defence that is provably exercised beats two that are not. (`check-attr`
    // takes pathNAMES, not pathspecs, so it needs no flag.)

    // A FILENAME MUST ALSO SURVIVE ITS OWN DECODE. Paths arrive already decoded
    // as UTF-8, and that decode is not injective, so two distinct paths on disk
    // can arrive as one string — and the content cache would then answer for the
    // wrong file. Refuse any name that does not re-encode to itself.
    if (Buffer.from(file, 'utf8').toString('utf8') !== file) {
      throw new Error(`filename is not round-trip UTF-8: ${file}`);
    }
    // MODE FIRST. `git show` returns the blob; readFileSync FOLLOWS SYMLINKS. A
    // manifest replaced by a symlink to identical text therefore compared equal
    // and was exempted, while git recorded a typechange (T) — the link target
    // then lives outside the rail and can be swapped without touching the railed
    // path again. Require a regular file at HEAD and an unchanged mode at base.
    if (!lstatSync(file).isFile()) throw new Error('not a regular file');

    // CONTENT FILTERS DESYNC THE COMPARISON. `git diff <base>` applies clean
    // filters and `ident` expansion; readFileSync returns raw working-tree bytes.
    // A .gitattributes filter can therefore rewrite `"main"` on the way into the
    // index while this comparator sees only an innocent version edit — the diff
    // and the committed blob disagree. Refuse to reason about any path carrying a
    // content-altering attribute.
    // `working-tree-encoding` belongs in this list. It re-encodes the file
    // between the working tree and the index, so a manifest holding `é` in
    // ISO-8859-1 on disk is committed as `Ã©` — a real change to a value like
    // `main`, invisible to a comparator that only reads the working tree.
    // Reproduced end-to-end at exit 0 before this was added.
    const attrs = git(['check-attr', 'filter', 'ident', 'working-tree-encoding', '--', file],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of attrs.split('\n')) {
      if (!line.trim()) continue;
      const value = line.slice(line.lastIndexOf(': ') + 2).trim();
      if (value !== 'unspecified' && value !== 'unset') throw new Error(`content filter on ${file}`);
    }

    // NOTE on the staged-vs-worktree split: cross-model review flagged that a
    // manifest staged as X but restored to Y in the working tree is committed as
    // X while this comparator sees Y. That is real, but it is NOT specific to the
    // exemption — `changedFiles(base)` is base-vs-worktree for EVERY rail check,
    // so the same gap already applies to ordinary rail edits. Requiring index and
    // worktree to agree here would reject the normal flow (edit, run the gate,
    // then stage) and is the wrong layer. Recorded as a guard-wide issue instead.

    const baseMode = git(['--literal-pathspecs', 'ls-tree', base, '--', file], { stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\s+/)[0];
    if (baseMode !== '100644' && baseMode !== '100755') throw new Error('base is not a regular file');
    const headExecutable = (lstatSync(file).mode & 0o111) !== 0;
    if ((baseMode === '100755') !== headExecutable) throw new Error('file mode changed');

    // READ RAW BYTES AND PROVE THE DECODE IS LOSSLESS.
    //
    // UTF-8 decoding is NOT injective: every invalid byte becomes U+FFFD. Reading
    // these as utf8 strings meant a baseline containing raw 0x80 and a working
    // tree containing raw 0x81 arrived here as the SAME string, so a genuine
    // byte-level difference compared equal and the edit was exempted. Reproduced
    // end-to-end against this binary.
    //
    // Decoding and re-encoding must reproduce the original buffer exactly. This
    // has to happen at the byte boundary — a string that already contains U+FFFD
    // re-encodes to itself perfectly, so no downstream check can recover the
    // information that was lost here.
    const decode = (buf) => {
      const text = buf.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error('not valid UTF-8');
      return text;
    };
    const before = decode(git(['show', `${base}:${file}`], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'buffer' }));
    const after = decode(readFileSync(file));
    contents = { before, after };
  } catch {
    contents = null;
  }
  contentCache.set(file, contents);
  return contents;
}

// --- run checks ---
const { railGlobs, railGlobError, violations, railsDiffEmpty, suppressionsClean } =
  runChecks({ changedFiles: files, diffText: diff, cliRails, ticket, isFenced, resolveContents });

const result = buildResult({
  violations,
  railGlobs,
  railGlobError,
  railsDiffEmpty,
  suppressionsClean,
  base,
  ticket,
});

// --- output ---
if (values.json) {
  printJson(result);
} else {
  if (violations.length === 0) {
    console.log('rails-guard: all checks passed');
    // A clean pass here is NOT full pre-merge clearance, and reading it as such
    // has already cost a red CI run: this command answers "did the diff edit a
    // frozen rail path?", while the CI gate additionally rejects any change to
    // an EXISTING ticket's contract in the trust root. A branch that reused a
    // ticket id another branch had claimed passed this check and failed that
    // one. Advisory, on stderr, so piping stdout is unaffected.
    console.error('note: CI also runs scripts/rails-guard-ci.mjs, which is stricter ' +
      '(it rejects changes to existing tickets in .adlc/tickets.json). Run `npm run preflight` for the full set.');
  } else {
    console.error(formatViolations(violations));
  }
}

// --- record on clean pass ---
if (values.record && violations.length === 0) {
  // Hash the repo files that match the rail globs (rails-diff-empty proof)
  let railFiles = {};
  if (railGlobs.length > 0) {
    try {
      const allFiles = git(['ls-files']).split('\n').filter(Boolean);
      const matched = allFiles.filter((f) => railGlobs.some((g) => globMatch(g, f)));
      railFiles = hashFiles(matched);
    } catch {
      // non-fatal — record with empty railFiles if git ls-files fails
    }
  }

  appendManifestEntry({
    ts: new Date().toISOString(),
    type: 'rails-check',
    ticket: ticket?.id ?? null,
    base,
    railsDiffEmpty: true,
    suppressionsClean: true,
    railFiles,
  }, undefined, { key: getKey() });
}

// --- exit ---
process.exit(violations.length > 0 ? 2 : 0);
