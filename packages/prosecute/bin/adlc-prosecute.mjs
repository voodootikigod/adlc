#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { parseArgs, printJson, opError, recordFinding, git, repoRoot, changedFiles } from '@adlc/core';
import { runProsecution, resolveProsecutionRevision } from '../lib/run.mjs';
import { classifyTrustRootTier } from '../lib/tier.mjs';
import { recordCrossModelReview } from '../lib/cross-model.mjs';

// FAIL-CLOSED distinction: a genuinely ABSENT ticket table contributes no rails
// (fine — nothing to check). But a table that EXISTS and is unreadable/malformed
// must NOT be silently treated as "no rails" — that would drop the rails
// dimension and let a change that is trust-root ONLY via a ticket rail evade the
// gate. So we throw on a present-but-corrupt table and let the caller op-error.
function readTicketArray(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`ticket table ${path} exists but cannot be read for tiering: ${err.message}`);
  }
  try {
    return JSON.parse(raw)?.tickets ?? [];
  } catch (err) {
    throw new Error(`ticket table ${path} is not valid JSON — tiering cannot proceed: ${err.message}`);
  }
}

// resolve(dir) is inside (or equal to) the repo root.
function isInsideRepo(root, resolvedDir) {
  const rel = relative(root, resolvedDir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Load the ticket table(s) whose `rails` define trust-root DENY paths for
// tiering. SECURITY: tiering is a GATE decision, so the rails source must be the
// repo's CANONICAL <repoRoot>/.adlc/tickets.json — never REPLACEABLE by a
// caller-supplied --dir. Otherwise `--dir ../elsewhere` pointing at a table that
// OMITS the rails would declassify a change that is trust-root via the repo's
// real rails (a gate bypass). We therefore ALWAYS include the canonical table,
// and only UNION an additional --dir table when that dir is CONTAINED within the
// repo (so a custom in-repo ADLC workspace still tiers). The classifier unions
// rails across all tickets, so extra sources can only ADD deny-paths (fail-safe),
// never remove them; an out-of-repo --dir contributes nothing to tiering.
function loadTicketsForTier(dir, root) {
  const tickets = [...readTicketArray(join(root, '.adlc', 'tickets.json'))];
  const resolvedDir = resolve(dir);
  if (isInsideRepo(root, resolvedDir) && resolvedDir !== resolve(root, '.adlc')) {
    tickets.push(...readTicketArray(join(resolvedDir, 'tickets.json')));
  }
  return tickets;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: 'string' },
    ticket: { type: 'string' },
    target: { type: 'string' },
    revision: { type: 'string' },
    dir: { type: 'string', default: '.adlc' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
    // Base ref used to compute the changed-file set for trust-root tiering.
    base: { type: 'string', default: 'main' },
    // record-cross-model attestation fields.
    provider: { type: 'string' },
    'author-provider': { type: 'string' },
    // --record-finding mode: land one CONFIRMED prosecution finding in the
    // findings ledger so P7 lesson-foundry can cluster it (closes the P5→P7 loop).
    'record-finding': { type: 'boolean', default: false },
    file: { type: 'string' },
    desc: { type: 'string' },
    category: { type: 'string' },
    severity: { type: 'string' },
    line: { type: 'string' },
    verdict: { type: 'string' },
  },
});

if (values.help) {
  console.log(`adlc-prosecute --input <passes.json> --ticket id [--target label] [--revision rev] [--base main] [--dir .adlc] [--json]

ADLC P5 review-evidence recorder.

  When the change under prosecution is TRUST-ROOT TIER (touches an enforcement
  package, a gated-artifact producer, a rails deny-path, or a trust-root file —
  computed from the WORKING TREE vs <base>: two-dot 'git diff --name-only <base>'
  unioned with untracked files, so an UNCOMMITTED trust-root edit still tiers), a
  clean P5 ALSO requires a recorded cross-model adversarial approve from a provider
  DISTINCT from the author, bound to the reviewed revision. A tiered run MUST declare
  the author via --author-provider <p> (or ADLC_AUTHOR_PROVIDER) — without it the run
  FAILS CLOSED (exit 1), since distinctness cannot be proven without the author. The
  tier reasons are printed to stderr on a tiered run. If <base> is unresolvable the
  run FAILS CLOSED (exit 1): CI must fetch/provide the base.

  record-cross-model --ticket id --provider <p> --author-provider <a> --verdict approve
                     [--revision rev] [--input <passes.json>] [--base main] [--dir .adlc]
      Register a cross-model attestation. Resolves the revision the SAME way the
      gate does (pass the same --input/--revision you use for the gate run) so the
      recorded revision matches. FAILS CLOSED if --provider === --author-provider.

  --record-finding --file <path> --desc "<prose>" [--category <lens>] [--severity <s>] [--line <n>] [--verdict <v>] [--dir .adlc]
      Record ONE confirmed prosecution finding to <dir>/findings.jsonl for P7
      (lesson-foundry). Call once per surviving finding on a NOT-CLEAR verdict.
      Use plain-prose --desc without quoted/backticked literals so it routes to a
      spec-gap template rather than a lint rule.

Exit codes:
  0  two consecutive dry passes recorded (or a finding/attestation recorded)
  1  operational error (e.g. a finding missing --file/--desc — fails closed)
  2  verified findings remain, dry-pass convergence failed, or a trust-root-tier
     change lacks a matching cross-model attestation
`);
  process.exit(0);
}

// --- record-cross-model subcommand (register a cross-model attestation) ---
if (positionals[0] === 'record-cross-model') {
  if (!values.ticket) opError('record-cross-model requires --ticket');
  let input;
  if (values.input) {
    try {
      input = JSON.parse(readFileSync(values.input, 'utf8'));
    } catch (err) {
      opError(`could not read --input: ${err.message}`);
    }
  }
  const revision = resolveProsecutionRevision({
    dir: values.dir,
    revision: values.revision,
    input,
    inputPath: values.input,
  });
  if (!revision) opError('revision could not be resolved; pass --revision or run inside a git worktree');
  let entry;
  try {
    entry = recordCrossModelReview({
      ticket: values.ticket,
      revision,
      provider: values.provider,
      authorProvider: values['author-provider'],
      verdict: values.verdict,
      dir: values.dir,
    });
  } catch (err) {
    opError(err.message); // fail closed: a same-provider or malformed attestation is exit 1, never recorded
  }
  if (values.json) {
    printJson(entry);
  } else {
    console.log(`recorded cross-model ${entry.data.verdict} for ${values.ticket} @ ${revision} (${entry.data.provider} vs author ${entry.data.authorProvider})`);
  }
  process.exit(0);
}

// --- record-finding mode (P5 → P7 bridge) ---
if (values['record-finding']) {
  let line;
  if (values.line !== undefined) {
    line = Number(values.line);
    if (!Number.isInteger(line) || line <= 0) opError(`--line must be a positive integer, got "${values.line}"`);
  }
  let entry;
  try {
    entry = recordFinding(
      {
        file: values.file,
        desc: values.desc,
        category: values.category,
        severity: values.severity,
        line,
        verdict: values.verdict,
      },
      values.dir
    );
  } catch (err) {
    opError(err.message); // fail closed: a malformed finding is exit 1, never a silent no-op
  }
  if (values.json) {
    printJson(entry);
  } else {
    console.log(`recorded finding → ${values.dir}/findings.jsonl (${entry.category}, ${entry.file})`);
  }
  process.exit(0);
}

if (!values.input) opError('usage: adlc-prosecute --input <passes.json> --ticket id');
if (!values.ticket) opError('usage: adlc-prosecute --input <passes.json> --ticket id');

let input;
try {
  input = JSON.parse(readFileSync(values.input, 'utf8'));
} catch (err) {
  opError(`could not read input: ${err.message}`);
}

// Classify the change under prosecution: if it is trust-root tier, a clean P5
// additionally requires a distinct-provider cross-model approve at this revision.
//
// WORKING-TREE-INCLUSIVE: prosecution binds to the working-tree revision
// (resolveRevision hashes the worktree), so the tier's changed-file set MUST match
// what is actually prosecuted — not just committed history. A three-dot
// `base...HEAD` diff misses an UNCOMMITTED edit to a trust-root file, which would
// let a converged P5 exit 0 with no attestation (fail-open). We therefore union:
//   • tracked changes of the working tree vs base (two-dot `git diff --name-only <base>`)
//   • untracked, non-ignored files (`git ls-files --others --exclude-standard`)
//
// FAIL CLOSED: if the changed-file set cannot be computed (base ref unresolvable,
// or not a git repo), we cannot decide whether the tier gate applies, so we REFUSE
// the run (exit 1) rather than fall back to an ungated P5. CI must provide the base
// (fetch it or pass --base <ref>); see docs/ci/rails-guard.yml.
let changed;
let root;
try {
  root = repoRoot();
  const tracked = changedFiles(values.base, root); // two-dot: working tree vs base
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root })
    .split('\0').filter(Boolean);
  changed = [...new Set([...tracked, ...untracked])];
} catch (err) {
  opError(`cannot determine trust-root tier: base ref '${values.base}' unresolvable — fetch the base (e.g. git fetch origin main) or pass --base <ref>. Underlying: ${err.message}`);
}
let tier;
try {
  tier = classifyTrustRootTier({ changedFiles: changed, tickets: loadTicketsForTier(values.dir, root) });
} catch (err) {
  opError(`cannot determine trust-root tier: ${err.message}`);
}
const requireCrossModel = tier.isTrustRootTier;
if (tier.isTrustRootTier) {
  console.error(`trust-root tier: cross-model adversarial approve REQUIRED (base ${values.base}). Reasons:`);
  for (const reason of tier.reasons) console.error(`  - ${reason}`);
}

// Author identity anchored to THIS invocation (never the attestation's self-report).
const authorProvider = values['author-provider'] ?? process.env.ADLC_AUTHOR_PROVIDER;

const result = runProsecution(input, {
  ticket: values.ticket,
  target: values.target,
  revision: values.revision,
  inputPath: values.input,
  dir: values.dir,
  requireCrossModel,
  authorProvider,
});

if (values.json) {
  printJson(result);
} else if (result.exitCode === 0) {
  console.log(result.message);
} else {
  console.error(result.message);
  if (result.errors) console.error(result.errors.join('\n'));
}

process.exit(result.exitCode);
