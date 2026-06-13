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
  appendEntry,
  hashFiles,
  git,
  globMatch,
  resolveBase,
  ADLC_DIR,
} from '@adlc/core';

import { runChecks } from '../lib/check.mjs';
import { formatViolations, buildResult } from '../lib/output.mjs';

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

// --- run checks ---
const { railGlobs, railGlobError, violations, railsDiffEmpty, suppressionsClean } =
  runChecks({ changedFiles: files, diffText: diff, cliRails, ticket });

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

  appendEntry('manifest', {
    ts: new Date().toISOString(),
    type: 'rails-check',
    ticket: ticket?.id ?? null,
    base,
    railsDiffEmpty: true,
    suppressionsClean: true,
    railFiles,
  });
}

// --- exit ---
process.exit(violations.length > 0 ? 2 : 0);
